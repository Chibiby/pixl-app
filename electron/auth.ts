import bcrypt from 'bcryptjs'
import type { Account, AccountPublic, LoginResult, SessionMode } from '@shared/types'
import { NO_CREDITS_MESSAGE } from '@shared/money'
import { getRuntimeConfig } from './config'
import { isAppFullyDisabled } from './disable'
import { getMachineIdCached } from './sync/identity'
import {
  getAccountByUsername,
  hasPendingMoneyOps,
  toPublic,
  upsertAccount
} from './sync/sqlite'
import { rpcLogin, rpcUpsertAccount, getSupabase, MONEY_RPCS_DEPLOYED } from './sync/supabase'

// Login rules:
//  - online: the login_account RPC is authoritative for credentials and for
//    single-session-per-account, and refreshes the cached row.
//  - offline: verify against the locally cached bcrypt hash.
//  - hybrid: if the server rejects credentials but a local bcrypt match exists
//    (offline-created account), upsert the local row then retry login once.
//  - balances: with MONEY_RPCS_DEPLOYED the server balances win on cache
//    unless local money ops are still queued; otherwise local balances are kept.

export interface LoginAttempt {
  result: LoginResult
  /** Server play-session id when the login was authoritative; null offline. */
  serverSessionId: string | null
}

// Development-only fixed credentials that unlock the admin panel with no
// database. Guarded by RuntimeConfig.devBypass so packaged builds are unaffected
// unless PIXL_DEV_BYPASS=1 is explicitly set.
const DEV_BYPASS_USERNAME = 'admin'
const DEV_BYPASS_PASSWORD = 'admin'

export async function attemptLogin(
  username: string,
  password: string,
  mode: SessionMode,
  purchaseCentavos = 0
): Promise<LoginAttempt> {
  const cfg = getRuntimeConfig()
  const machineId = getMachineIdCached()

  if (
    cfg.devBypass &&
    username === DEV_BYPASS_USERNAME &&
    password === DEV_BYPASS_PASSWORD
  ) {
    return { result: devBypassResult(), serverSessionId: null }
  }

  // Master disable: local admin auth only — never call login_account (would
  // open a server play session / mark the account in-use for clients).
  if (isAppFullyDisabled()) {
    return loginWhileDisabled(username, password)
  }

  if (getSupabase() && cfg.hasSupabase) {
    try {
      let res = await rpcLogin(username, password, machineId)
      if (res.outcome === 'error') {
        // Transient server/network error -> fall back to offline rules.
        return { result: offlineLogin(username, password, mode, purchaseCentavos), serverSessionId: null }
      }
      if (res.outcome === 'invalid_credentials') {
        // Offline-created account: push local row, then retry login once.
        const local = getAccountByUsername(username)
        if (local && safeCompare(password, local.password_hash)) {
          const up = await rpcUpsertAccount(local)
          if (up.status === 'ok') {
            res = await rpcLogin(username, password, machineId)
          } else if (up.status === 'network_error') {
            return {
              result: offlineLogin(username, password, mode, purchaseCentavos),
              serverSessionId: null
            }
          }
        }
        if (res.outcome === 'invalid_credentials') {
          return { result: rejection('invalid_credentials'), serverSessionId: null }
        }
      }
      if (res.outcome === 'in_use_elsewhere') {
        return { result: rejection(res.outcome), serverSessionId: null }
      }
      if (res.account) cacheAccount(res.account)
      // A server 'no_credits' only means the server's seconds balance is 0; the
      // local money balance may still cover the session, so gate locally. Such
      // a login has no server session id (the RPC did not open one).
      return {
        result: gate(username, mode, purchaseCentavos),
        serverSessionId: res.outcome === 'ok' ? res.sessionId : null
      }
    } catch {
      return { result: offlineLogin(username, password, mode, purchaseCentavos), serverSessionId: null }
    }
  }

  return { result: offlineLogin(username, password, mode, purchaseCentavos), serverSessionId: null }
}

// Merge the fresh server row with any existing cached row. Identity fields
// (hash, role, display name) come from the server. Server balances win when
// MONEY_RPCS_DEPLOYED unless pending local money ops would be clobbered.
function cacheAccount(fresh: Account): void {
  const existing = getAccountByUsername(fresh.username)
  const preferLocal =
    !MONEY_RPCS_DEPLOYED || hasPendingMoneyOps(existing?.id ?? fresh.id)
  upsertAccount({
    ...fresh,
    credits_centavos: preferLocal
      ? (existing?.credits_centavos ?? fresh.credits_centavos)
      : fresh.credits_centavos,
    time_balance_seconds: preferLocal
      ? (existing?.time_balance_seconds ?? fresh.time_balance_seconds)
      : fresh.time_balance_seconds,
    created_at: existing?.created_at ?? fresh.created_at
  })
}

function rejection(outcome: 'invalid_credentials' | 'in_use_elsewhere'): LoginResult {
  if (outcome === 'in_use_elsewhere') {
    return {
      outcome: 'in_use_elsewhere',
      message: 'Account is already in use on another PC',
      account: null
    }
  }
  return {
    outcome: 'invalid_credentials',
    message: 'Invalid username or password',
    account: null
  }
}

function offlineLogin(
  username: string,
  password: string,
  mode: SessionMode,
  purchaseCentavos: number
): LoginResult {
  const acc = getAccountByUsername(username)
  if (!acc || !safeCompare(password, acc.password_hash)) {
    return rejection('invalid_credentials')
  }
  // NOTE: offline we cannot verify single-session-per-account against the
  // server. The server reconciles this on reconnect.
  return gate(username, mode, purchaseCentavos)
}

/**
 * Auth while Pixl is master-disabled: verify against local bcrypt only.
 * Admins may enter the panel to re-enable; clients get a local error and
 * never hit login_account (no server session / in_session PC status).
 */
function loginWhileDisabled(username: string, password: string): LoginAttempt {
  const acc = getAccountByUsername(username)
  if (!acc || !safeCompare(password, acc.password_hash)) {
    return { result: rejection('invalid_credentials'), serverSessionId: null }
  }
  if (acc.role === 'admin') {
    return {
      result: { outcome: 'admin_ok', message: '', account: toPublic(acc) },
      serverSessionId: null
    }
  }
  return {
    result: {
      outcome: 'error',
      message: 'Pixl is disabled on this PC. An admin must open Pixl and re-enable it.',
      account: null
    },
    serverSessionId: null
  }
}

/**
 * Balance gate, applied identically online and offline:
 *  - admins always pass (they open the admin panel, not a play session)
 *  - clients with credits_centavos <= 0 AND time_balance_seconds <= 0 → no_credits
 *  - open burns money → credits required even if leftover time exists
 *  - timed: needs_time only when credits > 0 and time is 0; both zero is no_credits
 */
function gate(username: string, mode: SessionMode, purchaseCentavos: number): LoginResult {
  const acc = getAccountByUsername(username)
  if (!acc) return rejection('invalid_credentials')
  if (acc.role === 'admin') {
    return { outcome: 'admin_ok', message: '', account: toPublic(acc) }
  }

  const credits = acc.credits_centavos
  const time = acc.time_balance_seconds

  // Broke: cannot enter any session.
  if (credits <= 0 && time <= 0) {
    return { outcome: 'no_credits', message: NO_CREDITS_MESSAGE, account: toPublic(acc) }
  }

  if (mode === 'open') {
    // Open burns money — reject even if they somehow still have time.
    if (credits <= 0) {
      return { outcome: 'no_credits', message: NO_CREDITS_MESSAGE, account: toPublic(acc) }
    }
    return { outcome: 'ok', message: '', account: toPublic(acc) }
  }

  // Timed: zero time with credits → offer buy. Both-zero already returned no_credits.
  // Existing purchased time can start even at ₱0.
  if (time <= 0 && purchaseCentavos <= 0) {
    return {
      outcome: 'needs_time',
      message: '',
      account: toPublic(acc)
    }
  }
  return { outcome: 'ok', message: '', account: toPublic(acc) }
}

function safeCompare(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash)
  } catch {
    return false
  }
}

function devBypassResult(): LoginResult {
  const now = new Date().toISOString()
  const account: AccountPublic = {
    id: 'dev-admin',
    username: DEV_BYPASS_USERNAME,
    role: 'admin',
    credits_centavos: 0,
    time_balance_seconds: 0,
    display_name: 'Dev Admin',
    created_at: now,
    updated_at: now
  }
  return { outcome: 'admin_ok', message: '', account }
}

// Local bcrypt hashing for offline/admin-created accounts.
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}
