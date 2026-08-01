import { randomUUID } from 'crypto'
import type {
  AccountPublic,
  AdminAddCreditsInput,
  AdminAdjustBalanceInput,
  AdminLedgerFilter,
  AdminLedgerPage,
  AdminSessionFilter,
  AdminStats,
  AdminUpdateAccountInput,
  CreateAccountInput,
  Pc,
  SessionRowWithNames
} from '@shared/types'
import { pesosToCentavos } from '@shared/money'
import { hashPassword } from './auth'
import {
  accountTotals,
  adjustCredits,
  adjustTimeBalance,
  countActiveSessions,
  countAdmins,
  dailyTopupRevenue,
  deleteAccount,
  enqueue,
  getAccountById,
  getAccountByUsername,
  hasActiveSessionForAccount,
  insertLedger,
  ledgerTotals,
  listAccounts,
  listLedgerSummarized,
  listPcs,
  listSessions,
  nextSeq,
  toPublic,
  upsertAccount
} from './sync/sqlite'

// Admin operations. Top-ups are MONEY: the admin enters pesos, the account
// gains centavos, and the ledger records the centavo delta. Converting money
// into play time is the user's decision (see credits.ts / session:buyTime).
// Account create/update is applied to the local cache and queued as
// upsert_account (including password_hash) for the reconciler to push.

export function adminListAccounts(): AccountPublic[] {
  return listAccounts()
}

export function adminListPcs(): Pc[] {
  return listPcs()
}

/**
 * Accepts a bare limit (the original signature) or a filter object, so older
 * callers keep working while the panel filters by account.
 */
export function adminListSessions(
  filter: number | AdminSessionFilter = {}
): SessionRowWithNames[] {
  return listSessions(typeof filter === 'number' ? { limit: filter } : filter)
}

export function adminListLedger(filter: AdminLedgerFilter = {}): AdminLedgerPage {
  return listLedgerSummarized(filter)
}

/**
 * Dashboard snapshot. Every figure comes from a SQL aggregate — the ledger is
 * append-only and grows for the life of the shop, so it is never loaded whole.
 */
export function adminGetStats(): AdminStats {
  const totals = ledgerTotals()
  const accounts = accountTotals()
  return {
    ...totals,
    ...accounts,
    activeSessions: countActiveSessions(),
    pcs: listPcs(),
    dailyRevenue: zeroFillDays(dailyTopupRevenue(), 7),
    generatedAt: new Date().toISOString()
  }
}

/**
 * Turns the sparse per-day revenue rows into exactly `days` buckets ending
 * today. Keys are UTC days to match the SQL grouping (see sqlite.ts).
 */
function zeroFillDays(
  rows: Array<{ day: string; centavos: number }>,
  days: number
): Array<{ day: string; centavos: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r.centavos]))
  const today = new Date()
  const out: Array<{ day: string; centavos: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)
    )
    const key = d.toISOString().slice(0, 10)
    out.push({ day: key, centavos: byDay.get(key) ?? 0 })
  }
  return out
}

export function adminCreateAccount(input: CreateAccountInput): AccountPublic {
  const existing = getAccountByUsername(input.username)
  if (existing) {
    throw new Error(`Username "${input.username}" already exists`)
  }
  const now = new Date().toISOString()
  const centavos = Math.max(0, pesosToCentavos(input.initialPesos ?? 0))
  const account = {
    id: randomUUID(),
    username: input.username.trim(),
    password_hash: hashPassword(input.password),
    role: input.role,
    credits_centavos: centavos,
    time_balance_seconds: 0,
    display_name: input.displayName?.trim() || input.username.trim(),
    created_at: now,
    updated_at: now
  }
  upsertAccount(account)
  enqueue('upsert_account', {
    account_id: account.id,
    id: account.id,
    username: account.username,
    password_hash: account.password_hash,
    role: account.role,
    display_name: account.display_name,
    credits_centavos: account.credits_centavos,
    time_balance_seconds: account.time_balance_seconds,
    note: 'account created offline/admin'
  })
  if (centavos > 0) {
    insertLedger({
      id: randomUUID(),
      account_id: account.id,
      admin_id: null,
      kind: 'topup',
      delta_centavos: centavos,
      delta_seconds: 0,
      note: 'initial credits',
      created_at: now,
      synced_from: 'offline_queue',
      seq: nextSeq()
    })
  }
  return toPublic(account)
}

export function adminAddCredits(
  input: AdminAddCreditsInput,
  adminId: string | null
): AccountPublic {
  const account = getAccountById(input.accountId)
  if (!account) throw new Error('Account not found')

  const centavos = Math.max(0, pesosToCentavos(input.pesos ?? 0))
  const grantSeconds = Math.max(0, Math.round((input.grantMinutes ?? 0) * 60))
  if (centavos === 0 && grantSeconds === 0) throw new Error('Top-up amount is zero')

  const now = new Date().toISOString()
  const note = input.note ?? 'admin top-up'

  if (centavos > 0) {
    adjustCredits(account.id, centavos)
    insertLedger({
      id: randomUUID(),
      account_id: account.id,
      admin_id: adminId,
      kind: 'topup',
      delta_centavos: centavos,
      delta_seconds: 0,
      note,
      created_at: now,
      synced_from: 'offline_queue',
      seq: nextSeq()
    })
    // Queue the authoritative server write (needs the money-aware RPC).
    enqueue('admin_add_credits', {
      admin_id: adminId,
      account_id: account.id,
      delta_centavos: centavos,
      note,
      created_at: now
    })
  }

  // Optional courtesy time that costs the customer nothing (free hour, etc.).
  if (grantSeconds > 0) {
    adjustTimeBalance(account.id, grantSeconds)
    insertLedger({
      id: randomUUID(),
      account_id: account.id,
      admin_id: adminId,
      kind: 'grant',
      delta_centavos: 0,
      delta_seconds: grantSeconds,
      note,
      created_at: now,
      synced_from: 'offline_queue',
      seq: nextSeq()
    })
    enqueue('admin_grant_time', {
      admin_id: adminId,
      account_id: account.id,
      delta_seconds: grantSeconds,
      note,
      created_at: now
    })
  }

  const updated = getAccountById(account.id)!
  return toPublic(updated)
}

/**
 * Profile edit: display name, role and password reset. Balances and the ledger
 * are deliberately untouched — money moves through adminAddCredits /
 * adminAdjustBalance only. The username is immutable (it is the login identity
 * the server keys accounts on).
 */
export function adminUpdateAccount(
  input: AdminUpdateAccountInput,
  adminId: string | null
): AccountPublic {
  const account = getAccountById(input.accountId)
  if (!account) throw new Error('Account not found')

  const displayName = input.displayName?.trim()
  const nextRole = input.role ?? account.role
  const newPassword = input.newPassword ?? ''
  const roleChanged = nextRole !== account.role
  const nameChanged = displayName !== undefined && displayName !== account.display_name
  const resetPassword = newPassword.length > 0

  if (displayName !== undefined && displayName.length === 0) {
    throw new Error('Display name cannot be empty')
  }
  if (resetPassword && newPassword.length < 4) {
    throw new Error('Password must be at least 4 characters')
  }
  if (!roleChanged && !nameChanged && !resetPassword) {
    throw new Error('Nothing to update')
  }
  // Last-admin protection: demoting the only admin would lock everyone out of
  // this panel — and out of the maintenance quit path — with no way back in.
  // This also covers an admin demoting themselves, which is the common case.
  if (roleChanged && account.role === 'admin' && countAdmins() <= 1) {
    throw new Error('Cannot change the role of the only admin account')
  }

  const now = new Date().toISOString()
  const next = {
    ...account,
    display_name: displayName ?? account.display_name,
    role: nextRole,
    password_hash: resetPassword ? hashPassword(newPassword) : account.password_hash,
    updated_at: now
  }
  upsertAccount(next)
  enqueue('upsert_account', {
    account_id: next.id,
    id: next.id,
    username: next.username,
    password_hash: next.password_hash,
    role: next.role,
    display_name: next.display_name,
    credits_centavos: next.credits_centavos,
    time_balance_seconds: next.time_balance_seconds,
    admin_id: adminId,
    note: 'account updated offline/admin',
    created_at: now
  })
  return toPublic(next)
}

/**
 * Permanently remove an account from the local cache. Guards against locking
 * out the shop (last admin) and against deleting a customer who is still
 * playing. Related local ledger/sessions are cleaned up with the account.
 *
 * There is no deployed server delete RPC — the queue records a best-effort
 * delete_account note that the reconciler drops after logging, so offline
 * delete always succeeds locally.
 */
export function adminDeleteAccount(accountId: string, adminId: string | null): void {
  const account = getAccountById(accountId)
  if (!account) {
    // Soft-fail: already gone is a successful delete from the admin's POV.
    return
  }
  if (account.role === 'admin' && countAdmins() <= 1) {
    throw new Error('Cannot delete the only admin account')
  }
  if (hasActiveSessionForAccount(accountId)) {
    throw new Error(
      `Cannot delete @${account.username} while they have an active session — end the session first`
    )
  }

  const deleted = deleteAccount(accountId)
  if (!deleted) return

  enqueue('delete_account', {
    account_id: account.id,
    username: account.username,
    admin_id: adminId,
    note: 'account deleted offline/admin (local-only; no server delete RPC)',
    created_at: new Date().toISOString()
  })
}

/**
 * Signed correction of either balance, recorded as one 'adjust' ledger row.
 * Balances clamp at zero, so the row records the delta that ACTUALLY applied
 * (a −₱50 correction on a ₱20 balance books −₱20); otherwise the ledger would
 * drift away from the balances it is supposed to explain.
 */
export function adminAdjustBalance(
  input: AdminAdjustBalanceInput,
  adminId: string | null
): AccountPublic {
  const account = getAccountById(input.accountId)
  if (!account) throw new Error('Account not found')

  const note = input.note?.trim()
  if (!note) throw new Error('A note is required for an adjustment')

  const centavos = pesosToCentavos(input.deltaPesos ?? 0)
  const seconds = Math.round((input.deltaMinutes ?? 0) * 60)
  if (centavos === 0 && seconds === 0) throw new Error('Adjustment is zero')

  const appliedCentavos =
    centavos === 0 ? 0 : adjustCredits(account.id, centavos) - account.credits_centavos
  const appliedSeconds =
    seconds === 0 ? 0 : adjustTimeBalance(account.id, seconds) - account.time_balance_seconds
  if (appliedCentavos === 0 && appliedSeconds === 0) {
    throw new Error('Nothing to adjust — the balance is already at zero')
  }

  const now = new Date().toISOString()
  insertLedger({
    id: randomUUID(),
    account_id: account.id,
    admin_id: adminId,
    kind: 'adjust',
    delta_centavos: appliedCentavos,
    delta_seconds: appliedSeconds,
    note,
    created_at: now,
    synced_from: 'offline_queue',
    seq: nextSeq()
  })
  enqueue('admin_adjust', {
    admin_id: adminId,
    account_id: account.id,
    delta_centavos: appliedCentavos,
    delta_seconds: appliedSeconds,
    note,
    created_at: now
  })

  const updated = getAccountById(account.id)!
  return toPublic(updated)
}
