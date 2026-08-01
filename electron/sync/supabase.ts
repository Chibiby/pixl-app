import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getRuntimeConfig } from '../config'
import type { Account, PcStatus } from '@shared/types'

// The client PC only ever calls whitelisted Postgres RPC functions; it never
// touches tables directly (RLS blocks the anon key from doing so).
//
// The deployed server predates the money model: it stores a single seconds
// balance and exposes login_account / debit_session_time / admin_add_credits /
// heartbeat. Those still work for the TIMED half of the new model (seconds in,
// seconds out). The money half needs new RPCs, documented in the README
// ("Supabase RPC surface"); their client wrappers are written below and stay
// dormant behind MONEY_RPCS_DEPLOYED until the server ships them.

let client: SupabaseClient | null = null

/**
 * Flip to true once debit_session_credits / purchase_time / the centavo form of
 * admin_add_credits exist server-side. While false the reconciler keeps money
 * movements local-only (the SQLite ledger remains the record of truth) instead
 * of hammering RPCs that would 404 forever.
 */
export const MONEY_RPCS_DEPLOYED: boolean = true

export function getSupabase(): SupabaseClient | null {
  if (client) return client
  const cfg = getRuntimeConfig()
  if (!cfg.hasSupabase) return null
  client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  return client
}

interface LoginAccountPayload {
  id: string
  display_name: string
  role: 'client' | 'admin'
  /** Legacy seconds balance; maps onto the new purchased-time balance. */
  time_credits_seconds?: number
  /** Sent only by a money-aware server. */
  time_balance_seconds?: number
  credits_centavos?: number
  password_hash: string
}

export interface RpcLoginResult {
  outcome: 'ok' | 'no_credits' | 'invalid_credentials' | 'in_use_elsewhere' | 'error'
  account: Account | null
  /** Server-created play session id ('ok' for clients only; null for admins). */
  sessionId: string | null
  /** Server-side pcs.id for this machine. */
  pcId: string | null
}

// RPC: login_account(p_username, p_password, p_machine_id) -> jsonb
//   status: 'ok' | 'invalid' | 'already_in_use' | 'no_credits'
export async function rpcLogin(
  username: string,
  password: string,
  machineId: string
): Promise<RpcLoginResult> {
  const sb = getSupabase()
  if (!sb) return { outcome: 'error', account: null, sessionId: null, pcId: null }
  const { data, error } = await sb.rpc('login_account', {
    p_username: username,
    p_password: password,
    p_machine_id: machineId
  })
  if (error || !data) return { outcome: 'error', account: null, sessionId: null, pcId: null }

  const payload = data as {
    status: 'ok' | 'invalid' | 'already_in_use' | 'no_credits'
    account?: LoginAccountPayload
    session_id?: string | null
    pc_id?: string | null
  }

  const outcome =
    payload.status === 'ok'
      ? 'ok'
      : payload.status === 'no_credits'
        ? 'no_credits'
        : payload.status === 'already_in_use'
          ? 'in_use_elsewhere'
          : 'invalid_credentials'

  // The RPC payload omits username/timestamps; reconstruct a cacheable row.
  // A legacy (seconds-only) server contributes purchased time and no money.
  const now = new Date().toISOString()
  const account: Account | null = payload.account
    ? {
        id: payload.account.id,
        username,
        password_hash: payload.account.password_hash,
        role: payload.account.role,
        credits_centavos: payload.account.credits_centavos ?? 0,
        time_balance_seconds:
          payload.account.time_balance_seconds ?? payload.account.time_credits_seconds ?? 0,
        display_name: payload.account.display_name,
        created_at: now,
        updated_at: now
      }
    : null

  return {
    outcome,
    account,
    sessionId: payload.session_id ?? null,
    pcId: payload.pc_id ?? null
  }
}

export type UpsertAccountStatus = 'ok' | 'invalid_argument' | 'network_error'

// RPC: upsert_account(p_id, p_username, p_password_hash, p_role, p_display_name,
//                     p_credits_centavos, p_time_balance_seconds)
// Push a local (offline/admin-created) account so online login can succeed.
export async function rpcUpsertAccount(account: Account): Promise<{
  status: UpsertAccountStatus
  account: Account | null
}> {
  const sb = getSupabase()
  if (!sb) return { status: 'network_error', account: null }
  const { data, error } = await sb.rpc('upsert_account', {
    p_id: account.id,
    p_username: account.username,
    p_password_hash: account.password_hash,
    p_role: account.role,
    p_display_name: account.display_name,
    p_credits_centavos: Math.round(account.credits_centavos),
    p_time_balance_seconds: Math.round(account.time_balance_seconds)
  })
  if (error || !data) return { status: 'network_error', account: null }

  const payload = data as {
    status: 'ok' | 'invalid_argument'
    account?: LoginAccountPayload & { username?: string }
  }
  if (payload.status !== 'ok' || !payload.account) {
    return { status: payload.status === 'invalid_argument' ? 'invalid_argument' : 'network_error', account: null }
  }

  const now = new Date().toISOString()
  const row = payload.account
  return {
    status: 'ok',
    account: {
      id: row.id,
      username: row.username ?? account.username,
      password_hash: row.password_hash,
      role: row.role,
      credits_centavos: row.credits_centavos ?? 0,
      time_balance_seconds:
        row.time_balance_seconds ?? row.time_credits_seconds ?? 0,
      display_name: row.display_name,
      created_at: account.created_at || now,
      updated_at: now
    }
  }
}

export type DebitStatus =
  | 'ok'
  | 'credits_exhausted'
  | 'duplicate'
  | 'invalid_session'
  | 'invalid_argument'
  | 'network_error'

// RPC: debit_session_time(p_session_id, p_seconds, p_pc_seq, p_synced_from)
// Idempotent per (pc, pc_seq); clamps at 0 and closes the session when the
// balance hits zero. Used by TIMED sessions, whose drain is pure seconds.
export async function rpcDebitTime(params: {
  sessionId: string
  seconds: number
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{ status: DebitStatus; timeRemainingSeconds: number | null }> {
  const sb = getSupabase()
  if (!sb) return { status: 'network_error', timeRemainingSeconds: null }
  const { data, error } = await sb.rpc('debit_session_time', {
    p_session_id: params.sessionId,
    p_seconds: params.seconds,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) return { status: 'network_error', timeRemainingSeconds: null }
  const payload = data as {
    status: DebitStatus
    time_balance_seconds?: number
    time_credits_seconds?: number
  }
  const remaining = payload.time_balance_seconds ?? payload.time_credits_seconds
  return {
    status: payload.status,
    timeRemainingSeconds: typeof remaining === 'number' ? remaining : null
  }
}

// RPC (PLANNED): debit_session_credits(p_session_id, p_centavos, p_pc_seq, p_synced_from)
// Open-time money drain. Same idempotency contract as debit_session_time.
export async function rpcDebitCredits(params: {
  sessionId: string
  centavos: number
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{ status: DebitStatus; creditsCentavos: number | null }> {
  const sb = getSupabase()
  if (!sb) return { status: 'network_error', creditsCentavos: null }
  const { data, error } = await sb.rpc('debit_session_credits', {
    p_session_id: params.sessionId,
    p_centavos: params.centavos,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) return { status: 'network_error', creditsCentavos: null }
  const payload = data as { status: DebitStatus; credits_centavos?: number }
  return {
    status: payload.status,
    creditsCentavos:
      typeof payload.credits_centavos === 'number' ? payload.credits_centavos : null
  }
}

export type PurchaseTimeStatus =
  | 'ok'
  | 'insufficient_credits'
  | 'invalid_account'
  | 'duplicate'
  | 'invalid_argument'
  | 'network_error'

// RPC (PLANNED): purchase_time(p_account_id, p_centavos, p_seconds, p_pc_seq, p_synced_from)
// Atomically moves money into purchased time, writing one ledger row.
export async function rpcPurchaseTime(params: {
  accountId: string
  centavos: number
  seconds: number
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{
  status: PurchaseTimeStatus
  creditsCentavos: number | null
  timeBalanceSeconds: number | null
}> {
  const sb = getSupabase()
  if (!sb) {
    return { status: 'network_error', creditsCentavos: null, timeBalanceSeconds: null }
  }
  const { data, error } = await sb.rpc('purchase_time', {
    p_account_id: params.accountId,
    p_centavos: params.centavos,
    p_seconds: params.seconds,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) {
    return { status: 'network_error', creditsCentavos: null, timeBalanceSeconds: null }
  }
  const payload = data as {
    status: PurchaseTimeStatus
    credits_centavos?: number
    time_balance_seconds?: number
  }
  return {
    status: payload.status,
    creditsCentavos:
      typeof payload.credits_centavos === 'number' ? payload.credits_centavos : null,
    timeBalanceSeconds:
      typeof payload.time_balance_seconds === 'number' ? payload.time_balance_seconds : null
  }
}

export type SellTimeStatus =
  | 'ok'
  | 'invalid_account'
  | 'duplicate'
  | 'invalid_argument'
  | 'network_error'

// RPC: sell_time(p_account_id, p_centavos, p_seconds, p_pc_seq, p_synced_from)
// Refunds unused purchased time into money, writing one ledger row.
export async function rpcSellTime(params: {
  accountId: string
  centavos: number
  seconds: number
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{
  status: SellTimeStatus
  creditsCentavos: number | null
  timeBalanceSeconds: number | null
}> {
  const sb = getSupabase()
  if (!sb) {
    return { status: 'network_error', creditsCentavos: null, timeBalanceSeconds: null }
  }
  const { data, error } = await sb.rpc('sell_time', {
    p_account_id: params.accountId,
    p_centavos: params.centavos,
    p_seconds: params.seconds,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) {
    return { status: 'network_error', creditsCentavos: null, timeBalanceSeconds: null }
  }
  const payload = data as {
    status: SellTimeStatus
    credits_centavos?: number
    time_balance_seconds?: number
  }
  return {
    status: payload.status,
    creditsCentavos:
      typeof payload.credits_centavos === 'number' ? payload.credits_centavos : null,
    timeBalanceSeconds:
      typeof payload.time_balance_seconds === 'number' ? payload.time_balance_seconds : null
  }
}

export type AddCreditsStatus =
  | 'ok'
  | 'not_admin'
  | 'invalid_account'
  | 'invalid_argument'
  | 'network_error'

// RPC (PLANNED): admin_add_credits(p_admin_id, p_account_id, p_centavos, p_note, p_pc_seq, p_synced_from)
// The deployed version takes p_pesos and converts to seconds server-side; the
// money model needs the centavo form so no rounding happens twice.
export async function rpcAdminAddCredits(params: {
  adminId: string
  accountId: string
  centavos: number
  note: string | null
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{ status: AddCreditsStatus; creditsCentavos: number | null }> {
  const sb = getSupabase()
  if (!sb) return { status: 'network_error', creditsCentavos: null }
  const { data, error } = await sb.rpc('admin_add_credits', {
    p_admin_id: params.adminId,
    p_account_id: params.accountId,
    p_centavos: params.centavos,
    p_note: params.note,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) return { status: 'network_error', creditsCentavos: null }
  const payload = data as { status: AddCreditsStatus; credits_centavos?: number }
  return {
    status: payload.status,
    creditsCentavos:
      typeof payload.credits_centavos === 'number' ? payload.credits_centavos : null
  }
}

// RPC (PLANNED): admin_grant_time(p_admin_id, p_account_id, p_seconds, p_note, p_pc_seq, p_synced_from)
export async function rpcAdminGrantTime(params: {
  adminId: string
  accountId: string
  seconds: number
  note: string | null
  pcSeq: number
  syncedFrom: 'server' | 'offline_queue'
}): Promise<{ status: AddCreditsStatus; timeBalanceSeconds: number | null }> {
  const sb = getSupabase()
  if (!sb) return { status: 'network_error', timeBalanceSeconds: null }
  const { data, error } = await sb.rpc('admin_grant_time', {
    p_admin_id: params.adminId,
    p_account_id: params.accountId,
    p_seconds: params.seconds,
    p_note: params.note,
    p_pc_seq: params.pcSeq,
    p_synced_from: params.syncedFrom
  })
  if (error || !data) return { status: 'network_error', timeBalanceSeconds: null }
  const payload = data as { status: AddCreditsStatus; time_balance_seconds?: number }
  return {
    status: payload.status,
    timeBalanceSeconds:
      typeof payload.time_balance_seconds === 'number' ? payload.time_balance_seconds : null
  }
}

// RPC: heartbeat(p_machine_id, p_status, p_account_id)
// IMPORTANT: p_status must reflect the app's real state. Reporting 'locked'
// (or 'offline') with a null account closes any open server session for this
// PC — that is also the intended way to end sessions server-side on logout.
export async function rpcHeartbeat(params: {
  machineId: string
  status: PcStatus
  accountId: string | null
}): Promise<{ ok: boolean; pcId: string | null }> {
  const sb = getSupabase()
  if (!sb) return { ok: false, pcId: null }
  const { data, error } = await sb.rpc('heartbeat', {
    p_machine_id: params.machineId,
    p_status: params.status,
    p_account_id: params.accountId
  })
  if (error || !data) return { ok: false, pcId: null }
  const payload = data as { status: string; pc_id?: string }
  return { ok: payload.status === 'ok', pcId: payload.pc_id ?? null }
}
