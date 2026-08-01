import type { Account, PcStatus, SyncStatus } from '@shared/types'
import { getRuntimeConfig } from '../config'
import { getMachineIdCached } from './identity'
import {
  getAccountById,
  listAccounts,
  markQueueError,
  peekQueue,
  queueCount,
  removeQueued,
  setSetting,
  updateQueuedPayload,
  type SyncQueueItem
} from './sqlite'
import {
  getSupabase,
  rpcAdminAddCredits,
  rpcAdminGrantTime,
  rpcDebitCredits,
  rpcDebitTime,
  rpcHeartbeat,
  rpcPurchaseTime,
  rpcSellTime,
  rpcUpsertAccount,
  MONEY_RPCS_DEPLOYED
} from './supabase'

// The reconciler drains the SQLite sync_queue to Supabase in monotonic-seq
// order (per account). While offline it is a no-op — unlimited offline grace —
// and on reconnect it replays every queued write.
//
// Balance authority: with the money model the LOCAL cache is authoritative.
// The deployed server only tracks a seconds balance, so snapping local
// balances to it would erase money the customer paid for at the counter while
// this PC was offline. Once the money RPCs ship (MONEY_RPCS_DEPLOYED) the
// server can take authority back and this is where that would be wired.

type StatusListener = (s: SyncStatus) => void

/** Reports the app's real state for heartbeats (wired to the AppController). */
export type PcStatusProvider = () => { status: PcStatus; accountId: string | null }

/** Resolves the current server session id for an account (for offline-started debits). */
export type SessionResolver = (accountId: string) => string | null

let running = false
/** Serializes ticks so forceSync can wait for an in-flight tick then run another. */
let tickTail: Promise<void> = Promise.resolve()
let timer: NodeJS.Timeout | null = null
let online = false
let lastSyncAt: string | null = null
let lastError: string | null = null
const listeners = new Set<StatusListener>()

let statusProvider: PcStatusProvider = () => ({ status: 'locked', accountId: null })
let sessionResolver: SessionResolver = () => null
/** Once per reconciler online session: push local accounts that may be missing server-side. */
let localAccountsPushed = false

export function setStatusProvider(p: PcStatusProvider): void {
  statusProvider = p
}
export function setSessionResolver(r: SessionResolver): void {
  sessionResolver = r
}

/** True when there is no active local session that could attach orphaned debits. */
function isPcLockedOrIdle(): boolean {
  const { status, accountId } = statusProvider()
  return status === 'locked' || accountId == null
}

export function onSyncStatus(cb: StatusListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getSyncStatus(): SyncStatus {
  return {
    online,
    pendingCount: safeQueueCount(),
    lastSyncAt,
    lastError
  }
}

function safeQueueCount(): number {
  try {
    return queueCount()
  } catch {
    return 0
  }
}

function emit(): void {
  const status = getSyncStatus()
  for (const l of listeners) l(status)
}

export function startReconciler(intervalMs = 15000): void {
  if (timer) return
  const cfg = getRuntimeConfig()
  if (!cfg.hasSupabase) {
    // No Supabase configured: permanently offline (unlimited grace still applies).
    online = false
    lastError = 'Supabase not configured (.env missing SUPABASE_URL / SUPABASE_ANON_KEY)'
    emit()
    return
  }
  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  void tick()
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function forceSync(): Promise<SyncStatus> {
  // Always enqueue a fresh tick after any in-flight work so logout/mode-switch
  // callers observe post-lock state (heartbeat close + queue drain).
  await enqueueTick()
  return getSyncStatus()
}

async function tick(): Promise<void> {
  // Interval ticks skip when a tick is already running; forceSync uses enqueueTick.
  if (running) return
  await enqueueTick()
}

function enqueueTick(): Promise<void> {
  const run = tickTail.then(
    () => executeTick(),
    () => executeTick()
  )
  tickTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function executeTick(): Promise<void> {
  running = true
  try {
    const sb = getSupabase()
    if (!sb) {
      online = false
      return
    }

    // Heartbeat doubles as the connectivity probe. It MUST report the real app
    // status: 'locked' + null account tells the server to close any open
    // session for this PC (that is how logout is propagated), while
    // 'in_session' + account keeps it alive.
    const { status, accountId } = statusProvider()
    const hb = await rpcHeartbeat({
      machineId: getMachineIdCached(),
      status,
      accountId
    })
    online = hb.ok
    if (!hb.ok) {
      localAccountsPushed = false
      return
    }
    lastError = null
    if (hb.pcId) setSetting('server_pc_id', hb.pcId)

    await drainQueue()
    await pushLocalAccountsOnce()
    lastSyncAt = new Date().toISOString()
  } catch (err) {
    online = false
    localAccountsPushed = false
    lastError = err instanceof Error ? err.message : String(err)
  } finally {
    running = false
    emit()
  }
}

/**
 * Best-effort: upsert every local account once after coming online so
 * offline-created rows exist on the server. Failures are non-fatal — the
 * hybrid login path and queued upsert_account items cover the same gap.
 */
async function pushLocalAccountsOnce(): Promise<void> {
  if (localAccountsPushed) return
  localAccountsPushed = true
  for (const pub of listAccounts()) {
    const full = getAccountById(pub.id)
    if (!full?.password_hash) continue
    try {
      await rpcUpsertAccount(full)
    } catch {
      // leave for queue / hybrid login retry
    }
  }
}

/** Session-scoped debits must stay ordered vs each other; they use a server session id. */
function isSessionDebitKind(kind: string): boolean {
  return kind === 'session_time' || kind === 'session_tick' || kind === 'session_credits'
}

/** Account-level money RPCs — do not depend on a server session id. */
function isSessionIndependentMoneyKind(kind: string): boolean {
  return (
    kind === 'sell_time' ||
    kind === 'buy_time' ||
    kind === 'admin_add_credits' ||
    kind === 'admin_grant_time' ||
    kind === 'admin_adjust'
  )
}

async function drainQueue(): Promise<void> {
  const items = peekQueue(200)
  // Per-account ordering with a narrow exception: a retrying session debit must
  // not block later sell_time/buy_time (timed→open refunds). Other failures
  // still hard-block the account for the rest of this round.
  const sessionBlockedAccounts = new Set<string>()
  const hardBlockedAccounts = new Set<string>()

  for (const item of items) {
    const accountId = accountIdOf(item)
    if (accountId && hardBlockedAccounts.has(accountId)) continue
    if (
      accountId &&
      sessionBlockedAccounts.has(accountId) &&
      !isSessionIndependentMoneyKind(item.kind)
    ) {
      continue
    }

    const res = await pushItem(item)
    if (res.outcome === 'done') {
      removeQueued(item.id)
    } else if (res.outcome === 'drop') {
      // Permanently unpushable (e.g. server rejected the row) — remove but log.
      console.warn(`[sync] dropping queue item ${item.kind} seq=${item.seq}: ${res.reason}`)
      markQueueError(item.id, res.reason)
      removeQueued(item.id)
    } else {
      if (accountId) {
        if (isSessionDebitKind(item.kind)) sessionBlockedAccounts.add(accountId)
        else hardBlockedAccounts.add(accountId)
      }
      markQueueError(item.id, res.reason)
    }
  }
}

function accountIdOf(item: SyncQueueItem): string | null {
  try {
    const p = JSON.parse(item.payload)
    return typeof p.account_id === 'string' ? p.account_id : null
  } catch {
    return null
  }
}

type PushResult =
  | { outcome: 'done' }
  | { outcome: 'retry'; reason: string }
  | { outcome: 'drop'; reason: string }

/**
 * Money movements have no home on the deployed (seconds-only) server. Rather
 * than retry a non-existent RPC forever and grow the queue without bound, they
 * are dropped from the queue with a warning — the local `credit_ledger` row is
 * still the durable record, and a future backfill can replay it.
 */
function moneyRpcUnavailable(what: string): PushResult {
  return {
    outcome: 'drop',
    reason: `${what} RPC not deployed; kept in the local ledger only`
  }
}

async function pushItem(item: SyncQueueItem): Promise<PushResult> {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(item.payload)
  } catch {
    return { outcome: 'drop', reason: 'unparseable payload' }
  }

  switch (item.kind) {
    // 'session_tick' is the pre-money-model name for the same seconds debit.
    case 'session_tick':
    case 'session_time': {
      const seconds = Math.abs(Number(payload.delta_seconds ?? 0))
      if (seconds <= 0) return { outcome: 'drop', reason: 'zero-second debit' }

      const sessionId = resolveSessionId(payload)
      if (!sessionId) {
        // After logout the PC is locked and no session can attach — drop so
        // later sell_time / buy_time for this account are not blocked forever.
        if (isPcLockedOrIdle()) {
          return {
            outcome: 'drop',
            reason: 'orphaned session debit: no server session while PC locked'
          }
        }
        return {
          outcome: 'retry',
          reason: 'no server session yet for offline debit (will attach on next online login)'
        }
      }

      const res = await rpcDebitTime({
        sessionId,
        seconds,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      switch (res.status) {
        case 'ok':
        case 'credits_exhausted':
        case 'duplicate':
          return { outcome: 'done' }
        case 'invalid_session':
          return handleInvalidSessionDebit(item, payload, 'session debit')
        case 'invalid_argument':
          return { outcome: 'drop', reason: 'server rejected debit arguments' }
        case 'network_error':
        default:
          return { outcome: 'retry', reason: 'network error' }
      }
    }

    case 'session_credits': {
      const centavos = Math.abs(Number(payload.delta_centavos ?? 0))
      if (centavos <= 0) return { outcome: 'drop', reason: 'zero-centavo debit' }
      if (!MONEY_RPCS_DEPLOYED) return moneyRpcUnavailable('debit_session_credits')

      const sessionId = resolveSessionId(payload)
      if (!sessionId) {
        if (isPcLockedOrIdle()) {
          return {
            outcome: 'drop',
            reason: 'orphaned open-time debit: no server session while PC locked'
          }
        }
        return { outcome: 'retry', reason: 'no server session yet for open-time debit' }
      }
      const res = await rpcDebitCredits({
        sessionId,
        centavos,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      switch (res.status) {
        case 'ok':
        case 'credits_exhausted':
        case 'duplicate':
          return { outcome: 'done' }
        case 'invalid_session':
          return handleInvalidSessionDebit(item, payload, 'open-time debit')
        case 'invalid_argument':
          return { outcome: 'drop', reason: 'server rejected open-time debit arguments' }
        case 'network_error':
        default:
          return { outcome: 'retry', reason: 'network error' }
      }
    }

    case 'buy_time': {
      const centavos = Math.abs(Number(payload.delta_centavos ?? 0))
      const seconds = Math.abs(Number(payload.delta_seconds ?? 0))
      if (centavos <= 0 || seconds <= 0) return { outcome: 'drop', reason: 'empty purchase' }
      if (!MONEY_RPCS_DEPLOYED) return moneyRpcUnavailable('purchase_time')

      const res = await rpcPurchaseTime({
        accountId: String(payload.account_id ?? ''),
        centavos,
        seconds,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      switch (res.status) {
        case 'ok':
        case 'duplicate':
          return { outcome: 'done' }
        case 'insufficient_credits':
        case 'invalid_account':
        case 'invalid_argument':
          return { outcome: 'drop', reason: `server rejected purchase: ${res.status}` }
        case 'network_error':
        default:
          return { outcome: 'retry', reason: 'network error' }
      }
    }

    case 'sell_time': {
      const centavos = Math.abs(Number(payload.delta_centavos ?? 0))
      const seconds = Math.abs(Number(payload.delta_seconds ?? 0))
      if (seconds <= 0) return { outcome: 'drop', reason: 'empty refund' }
      if (!MONEY_RPCS_DEPLOYED) return moneyRpcUnavailable('sell_time')

      const res = await rpcSellTime({
        accountId: String(payload.account_id ?? ''),
        centavos,
        seconds,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      switch (res.status) {
        case 'ok':
        case 'duplicate':
          return { outcome: 'done' }
        case 'invalid_account':
        case 'invalid_argument':
          return { outcome: 'drop', reason: `server rejected sell_time: ${res.status}` }
        case 'network_error':
        default:
          return { outcome: 'retry', reason: 'network error' }
      }
    }

    case 'admin_add_credits': {
      const centavos = Number(payload.delta_centavos ?? 0)
      if (centavos <= 0) return { outcome: 'drop', reason: 'zero top-up' }
      if (!MONEY_RPCS_DEPLOYED) return moneyRpcUnavailable('admin_add_credits (centavos)')

      const res = await rpcAdminAddCredits({
        adminId: String(payload.admin_id ?? ''),
        accountId: String(payload.account_id ?? ''),
        centavos,
        note: typeof payload.note === 'string' ? payload.note : null,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      return mapAdminResult(res.status, 'top-up')
    }

    case 'admin_grant_time': {
      const seconds = Number(payload.delta_seconds ?? 0)
      if (seconds <= 0) return { outcome: 'drop', reason: 'zero time grant' }
      if (!MONEY_RPCS_DEPLOYED) return moneyRpcUnavailable('admin_grant_time')

      const res = await rpcAdminGrantTime({
        adminId: String(payload.admin_id ?? ''),
        accountId: String(payload.account_id ?? ''),
        seconds,
        note: typeof payload.note === 'string' ? payload.note : null,
        pcSeq: item.seq,
        syncedFrom: 'offline_queue'
      })
      return mapAdminResult(res.status, 'time grant')
    }

    case 'admin_adjust': {
      const centavos = Number(payload.delta_centavos ?? 0)
      const seconds = Number(payload.delta_seconds ?? 0)
      if (centavos === 0 && seconds === 0) return { outcome: 'drop', reason: 'empty adjustment' }
      // Corrections have no RPC even in the money-model surface (the server
      // exposes add/grant only), so the local ledger row stays the record.
      return moneyRpcUnavailable('admin_adjust')
    }

    case 'upsert_account':
      return pushUpsertAccount(payload)

    case 'delete_account':
      // No admin_delete_account (or equivalent) RPC is deployed. Local delete
      // already applied; drop the queue note so it does not retry forever.
      return {
        outcome: 'drop',
        reason: 'delete_account RPC not deployed; deleted locally only'
      }

    case 'login': {
      // Legacy create_account / update_account were queued under kind 'login'
      // with a nested kind — push those instead of silently marking done.
      const nested = typeof payload.kind === 'string' ? payload.kind : ''
      if (nested === 'create_account' || nested === 'update_account' || nested === 'upsert_account') {
        return pushUpsertAccount(payload)
      }
      return { outcome: 'done' }
    }

    case 'ledger':
    case 'credit_ledger':
    case 'session_end':
      // Informational/local-only rows; server state is carried by heartbeat.
      return { outcome: 'done' }

    default:
      return { outcome: 'done' }
  }
}

async function pushUpsertAccount(payload: Record<string, unknown>): Promise<PushResult> {
  const account = resolveUpsertAccount(payload)
  if (!account) {
    return { outcome: 'drop', reason: 'upsert_account missing local account/password_hash' }
  }
  const res = await rpcUpsertAccount(account)
  switch (res.status) {
    case 'ok':
      return { outcome: 'done' }
    case 'invalid_argument':
      return { outcome: 'drop', reason: 'server rejected upsert_account arguments' }
    case 'network_error':
    default:
      return { outcome: 'retry', reason: 'network error' }
  }
}

/** Build an Account for upsert from a flat/nested queue payload, falling back to local cache. */
function resolveUpsertAccount(payload: Record<string, unknown>): Account | null {
  const nested =
    payload.account && typeof payload.account === 'object'
      ? (payload.account as Record<string, unknown>)
      : null
  const src = nested ?? payload

  const id =
    (typeof src.id === 'string' && src.id) ||
    (typeof payload.account_id === 'string' && payload.account_id) ||
    ''
  const local = id ? getAccountById(id) : null

  const username =
    (typeof src.username === 'string' && src.username) || local?.username || ''
  const password_hash =
    (typeof src.password_hash === 'string' && src.password_hash) ||
    local?.password_hash ||
    ''
  if (!id || !username || !password_hash) return null

  const role = src.role === 'admin' || src.role === 'client' ? src.role : local?.role
  if (!role) return null

  return {
    id,
    username,
    password_hash,
    role,
    credits_centavos: Math.round(
      Number(src.credits_centavos ?? local?.credits_centavos ?? 0)
    ),
    time_balance_seconds: Math.round(
      Number(src.time_balance_seconds ?? local?.time_balance_seconds ?? 0)
    ),
    display_name:
      (typeof src.display_name === 'string' && src.display_name) ||
      local?.display_name ||
      username,
    created_at: local?.created_at ?? new Date().toISOString(),
    updated_at: local?.updated_at ?? new Date().toISOString()
  }
}

/**
 * Debits are keyed by the SERVER session id. Online logins record it;
 * offline-started sessions have none until the next online login for the same
 * account on this PC produces one.
 */
function resolveSessionId(payload: Record<string, unknown>): string | null {
  if (typeof payload.session_id === 'string' && payload.session_id) return payload.session_id
  if (typeof payload.account_id === 'string') return sessionResolver(payload.account_id)
  return null
}

/**
 * invalid_session: drop when locked/idle, or when no local session can still
 * claim the failed id (mode switch with null serverSessionId, or a replacement
 * session). Strip-and-retry only if the resolver still returns that same id.
 */
function handleInvalidSessionDebit(
  item: SyncQueueItem,
  payload: Record<string, unknown>,
  label: string
): PushResult {
  const failedId = typeof payload.session_id === 'string' ? payload.session_id : null
  if (isPcLockedOrIdle() || !failedId) {
    return {
      outcome: 'drop',
      reason: `orphaned ${label}: invalid or missing server session`
    }
  }
  const accountId = typeof payload.account_id === 'string' ? payload.account_id : null
  const current = accountId ? sessionResolver(accountId) : null
  if (!current || current !== failedId) {
    return {
      outcome: 'drop',
      reason: `orphaned ${label}: server session gone or replaced`
    }
  }
  updateQueuedPayload(item.id, { ...payload, session_id: null })
  return { outcome: 'retry', reason: 'server session closed; will re-attach' }
}

function mapAdminResult(
  status: 'ok' | 'not_admin' | 'invalid_account' | 'invalid_argument' | 'network_error',
  what: string
): PushResult {
  switch (status) {
    case 'ok':
      return { outcome: 'done' }
    case 'not_admin':
    case 'invalid_account':
    case 'invalid_argument':
      return { outcome: 'drop', reason: `server rejected ${what}: ${status}` }
    case 'network_error':
    default:
      return { outcome: 'retry', reason: 'network error' }
  }
}
