import Database from 'better-sqlite3'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type {
  Account,
  AccountPublic,
  AdminDailyRevenue,
  AdminLedgerFilter,
  AdminSessionFilter,
  LedgerKind,
  LedgerRow,
  LedgerRowWithNames,
  Pc,
  PcStatus,
  SessionEndedReason,
  SessionMode,
  SessionRow,
  SessionRowWithNames
} from '@shared/types'

// SQLite is the local, per-PC durable cache and offline queue. It mirrors the
// Supabase schema closely so reconciliation is a straight replay of queued rows.
// Balances live here as integers only: money in centavos, time in seconds.

let db: Database.Database

export interface SyncQueueItem {
  id: string
  kind:
    | 'ledger'
    | 'session_time'
    | 'session_credits'
    | 'buy_time'
    | 'sell_time'
    | 'session_end'
    | 'login'
    | 'upsert_account'
    | 'delete_account'
    | 'admin_add_credits'
    | 'admin_grant_time'
    | 'admin_adjust'
    // Pre-money-model rows that may still be sitting in an upgraded queue.
    | 'credit_ledger'
    | 'session_tick'
  payload: string // JSON
  created_at: string
  seq: number
  attempts: number
  last_error: string | null
}

export function initDb(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'pixl-cache.sqlite')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate()
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('SQLite not initialized; call initDb() first')
  return db
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      credits_centavos INTEGER NOT NULL DEFAULT 0,
      time_balance_seconds INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pcs (
      id TEXT PRIMARY KEY,
      machine_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      last_seen_at TEXT,
      current_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'locked'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      pc_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'timed',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      seconds_used INTEGER NOT NULL DEFAULT 0,
      centavos_used INTEGER NOT NULL DEFAULT 0,
      ended_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      admin_id TEXT,
      kind TEXT NOT NULL DEFAULT 'adjust',
      delta_centavos INTEGER NOT NULL DEFAULT 0,
      delta_seconds INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL,
      synced_from TEXT NOT NULL DEFAULT 'offline_queue',
      seq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    -- Monotonic per-PC sequence counter, immune to wall-clock tampering.
    CREATE TABLE IF NOT EXISTS seq_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO seq_counter (id, value) VALUES (1, 0);
  `)

  // Upgrade path from the time-only model. Every step is guarded by a column
  // check so re-running migrate() on an already-migrated cache is a no-op.
  addColumn('accounts', 'credits_centavos', 'INTEGER NOT NULL DEFAULT 0')
  const timeBalanceAdded = addColumn(
    'accounts',
    'time_balance_seconds',
    'INTEGER NOT NULL DEFAULT 0'
  )
  if (timeBalanceAdded && hasColumn('accounts', 'time_credits_seconds')) {
    // One-time carry-over: the old seconds balance becomes purchased time.
    // `time_credits_seconds` is left in place (unused) so a rollback can read it.
    db.exec('UPDATE accounts SET time_balance_seconds = time_credits_seconds')
  }

  addColumn('sessions', 'mode', `TEXT NOT NULL DEFAULT 'timed'`)
  addColumn('sessions', 'centavos_used', 'INTEGER NOT NULL DEFAULT 0')

  addColumn('credit_ledger', 'kind', `TEXT NOT NULL DEFAULT 'adjust'`)
  addColumn('credit_ledger', 'delta_centavos', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('credit_ledger', 'delta_seconds', 'INTEGER NOT NULL DEFAULT 0')
}

function hasColumn(table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

/** Adds a column if it is missing. Returns true when it was actually added. */
function addColumn(table: string, column: string, definition: string): boolean {
  if (hasColumn(table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

// ---- Monotonic sequence ----

export function nextSeq(): number {
  const row = db
    .prepare('UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value')
    .get() as { value: number }
  return row.value
}

// ---- Settings ----

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

// ---- Accounts ----

export function upsertAccount(a: Account): void {
  // Bound field-by-field: rows read back with SELECT * still carry the legacy
  // `time_credits_seconds` column, which is not part of this statement.
  db.prepare(
    `INSERT INTO accounts (id, username, password_hash, role, credits_centavos, time_balance_seconds, display_name, created_at, updated_at)
     VALUES (@id, @username, @password_hash, @role, @credits_centavos, @time_balance_seconds, @display_name, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       password_hash = excluded.password_hash,
       role = excluded.role,
       credits_centavos = excluded.credits_centavos,
       time_balance_seconds = excluded.time_balance_seconds,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at`
  ).run({
    id: a.id,
    username: a.username,
    password_hash: a.password_hash,
    role: a.role,
    credits_centavos: Math.round(a.credits_centavos),
    time_balance_seconds: Math.round(a.time_balance_seconds),
    display_name: a.display_name,
    created_at: a.created_at,
    updated_at: a.updated_at
  })
}

export function getAccountByUsername(username: string): Account | null {
  const row = db
    .prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE')
    .get(username) as Account | undefined
  return row ?? null
}

export function getAccountById(id: string): Account | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | Account
    | undefined
  return row ?? null
}

export function listAccounts(): AccountPublic[] {
  const rows = db
    .prepare(
      'SELECT id, username, role, credits_centavos, time_balance_seconds, display_name, created_at, updated_at FROM accounts ORDER BY username COLLATE NOCASE'
    )
    .all() as AccountPublic[]
  return rows
}

/**
 * Removes the account and its local sessions/ledger for cleanliness. Soft-fails
 * (returns false) when the row is already gone. Does not touch the sync queue —
 * callers enqueue a delete_account note separately. PC current_account_id refs
 * are cleared so stations do not point at a missing account.
 */
export function deleteAccount(accountId: string): boolean {
  const existing = getAccountById(accountId)
  if (!existing) return false

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM credit_ledger WHERE account_id = ?').run(accountId)
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId)
    db.prepare(
      `UPDATE pcs SET current_account_id = NULL
        WHERE current_account_id = ?`
    ).run(accountId)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId)
  })
  tx()
  return true
}

/** True when this account still has an unended local session. */
export function hasActiveSessionForAccount(accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sessions
        WHERE account_id = ? AND ended_at IS NULL
        LIMIT 1`
    )
    .get(accountId) as { ok: number } | undefined
  return !!row
}

/** How many accounts currently hold the admin role (last-admin protection). */
export function countAdmins(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE role = 'admin'`).get() as {
    c: number
  }
  return row.c
}

/** Applies a centavo delta to the money balance, clamped at 0. */
export function adjustCredits(accountId: string, deltaCentavos: number): number {
  const row = db
    .prepare(
      `UPDATE accounts
         SET credits_centavos = MAX(0, credits_centavos + ?),
             updated_at = ?
       WHERE id = ?
       RETURNING credits_centavos`
    )
    .get(Math.round(deltaCentavos), new Date().toISOString(), accountId) as
    | { credits_centavos: number }
    | undefined
  return row?.credits_centavos ?? 0
}

/** Applies a seconds delta to the purchased-time balance, clamped at 0. */
export function adjustTimeBalance(accountId: string, deltaSeconds: number): number {
  const row = db
    .prepare(
      `UPDATE accounts
         SET time_balance_seconds = MAX(0, time_balance_seconds + ?),
             updated_at = ?
       WHERE id = ?
       RETURNING time_balance_seconds`
    )
    .get(Math.round(deltaSeconds), new Date().toISOString(), accountId) as
    | { time_balance_seconds: number }
    | undefined
  return row?.time_balance_seconds ?? 0
}

export interface Balances {
  credits_centavos: number
  time_balance_seconds: number
}

/**
 * Moves money into time atomically. Returns null when the account cannot cover
 * the purchase, so the caller never writes a half-applied ledger row.
 */
export function convertCreditsToTime(
  accountId: string,
  centavos: number,
  seconds: number
): Balances | null {
  const tx = db.transaction((): Balances | null => {
    const acc = db.prepare('SELECT credits_centavos FROM accounts WHERE id = ?').get(accountId) as
      | { credits_centavos: number }
      | undefined
    if (!acc || acc.credits_centavos < centavos) return null
    return db
      .prepare(
        `UPDATE accounts
           SET credits_centavos = credits_centavos - ?,
               time_balance_seconds = time_balance_seconds + ?,
               updated_at = ?
         WHERE id = ?
         RETURNING credits_centavos, time_balance_seconds`
      )
      .get(centavos, seconds, new Date().toISOString(), accountId) as Balances
  })
  return tx()
}

/**
 * Refunds purchased time into money atomically. Clamps the seconds debit so a
 * stale caller cannot drive the time balance negative.
 * Args: (accountId, centavos, seconds).
 */
export function convertTimeToCredits(
  accountId: string,
  centavos: number,
  seconds: number
): Balances | null {
  const tx = db.transaction((): Balances | null => {
    const acc = db
      .prepare('SELECT time_balance_seconds FROM accounts WHERE id = ?')
      .get(accountId) as { time_balance_seconds: number } | undefined
    if (!acc) return null
    const debitSeconds = Math.min(Math.max(0, seconds), Math.max(0, acc.time_balance_seconds))
    // Nothing to convert — caller must not write a sell_time ledger/queue row.
    if (debitSeconds <= 0) return null
    const askedSeconds = Math.max(0, seconds)
    const creditCentavos = Math.max(
      0,
      Math.round(
        askedSeconds > 0 && debitSeconds < askedSeconds
          ? (centavos * debitSeconds) / askedSeconds
          : centavos
      )
    )
    return db
      .prepare(
        `UPDATE accounts
           SET credits_centavos = credits_centavos + ?,
               time_balance_seconds = time_balance_seconds - ?,
               updated_at = ?
         WHERE id = ?
         RETURNING credits_centavos, time_balance_seconds`
      )
      .get(creditCentavos, debitSeconds, new Date().toISOString(), accountId) as Balances
  })
  return tx()
}

export function toPublic(a: Account): AccountPublic {
  return {
    id: a.id,
    username: a.username,
    role: a.role,
    credits_centavos: a.credits_centavos,
    time_balance_seconds: a.time_balance_seconds,
    display_name: a.display_name,
    created_at: a.created_at,
    updated_at: a.updated_at
  }
}

// ---- PCs ----

export function upsertPc(pc: Pc): void {
  db.prepare(
    `INSERT INTO pcs (id, machine_id, name, last_seen_at, current_account_id, status)
     VALUES (@id, @machine_id, @name, @last_seen_at, @current_account_id, @status)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       last_seen_at = excluded.last_seen_at,
       current_account_id = excluded.current_account_id,
       status = excluded.status`
  ).run(pc)
}

export function getOrCreatePc(machineId: string, name: string): Pc {
  const existing = db.prepare('SELECT * FROM pcs WHERE machine_id = ?').get(machineId) as
    | Pc
    | undefined
  if (existing) return existing
  const pc: Pc = {
    id: randomUUID(),
    machine_id: machineId,
    name,
    last_seen_at: new Date().toISOString(),
    current_account_id: null,
    status: 'locked'
  }
  upsertPc(pc)
  return pc
}

export function setPcStatus(
  pcId: string,
  status: PcStatus,
  currentAccountId: string | null
): void {
  db.prepare(
    'UPDATE pcs SET status = ?, current_account_id = ?, last_seen_at = ? WHERE id = ?'
  ).run(status, currentAccountId, new Date().toISOString(), pcId)
}

export function listPcs(): Pc[] {
  return db.prepare('SELECT * FROM pcs ORDER BY name').all() as Pc[]
}

// ---- Sessions ----

export function createSession(accountId: string, pcId: string, mode: SessionMode): SessionRow {
  const s: SessionRow = {
    id: randomUUID(),
    account_id: accountId,
    pc_id: pcId,
    mode,
    started_at: new Date().toISOString(),
    ended_at: null,
    seconds_used: 0,
    centavos_used: 0,
    ended_reason: null
  }
  db.prepare(
    `INSERT INTO sessions (id, account_id, pc_id, mode, started_at, ended_at, seconds_used, centavos_used, ended_reason)
     VALUES (@id, @account_id, @pc_id, @mode, @started_at, @ended_at, @seconds_used, @centavos_used, @ended_reason)`
  ).run(s)
  return s
}

export function updateSessionUsage(
  sessionId: string,
  secondsUsed: number,
  centavosUsed: number
): void {
  db.prepare('UPDATE sessions SET seconds_used = ?, centavos_used = ? WHERE id = ?').run(
    secondsUsed,
    centavosUsed,
    sessionId
  )
}

/** Mid-visit Timed ↔ Open: keep the same sessions row, only flip mode. */
export function updateSessionMode(sessionId: string, mode: SessionMode): void {
  db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, sessionId)
}

export function endSession(
  sessionId: string,
  secondsUsed: number,
  centavosUsed: number,
  reason: SessionEndedReason
): void {
  db.prepare(
    'UPDATE sessions SET seconds_used = ?, centavos_used = ?, ended_at = ?, ended_reason = ? WHERE id = ?'
  ).run(secondsUsed, centavosUsed, new Date().toISOString(), reason, sessionId)
}

/** Max gap between consecutive rows that still count as one mode-switch split. */
const SESSION_MERGE_GAP_MS = 5_000

/**
 * Collapse consecutive same-account+same-pc rows that were artificially split by
 * older mode-switch logic (close + reopen within a few seconds) into one visit.
 */
export function mergeFragmentedSessions(rows: SessionRowWithNames[]): SessionRowWithNames[] {
  if (rows.length <= 1) return rows
  // Work oldest → newest so each merge extends the visit forward.
  const chrono = [...rows].reverse()
  const merged: SessionRowWithNames[] = []
  for (const row of chrono) {
    const prev = merged[merged.length - 1]
    if (prev && shouldMergeSessionFragments(prev, row)) {
      merged[merged.length - 1] = {
        ...prev,
        mode: row.mode,
        ended_at: row.ended_at,
        seconds_used: prev.seconds_used + row.seconds_used,
        centavos_used: prev.centavos_used + row.centavos_used,
        ended_reason: row.ended_reason
      }
    } else {
      merged.push({ ...row })
    }
  }
  return merged.reverse()
}

function shouldMergeSessionFragments(
  earlier: SessionRowWithNames,
  later: SessionRowWithNames
): boolean {
  if (earlier.account_id !== later.account_id || earlier.pc_id !== later.pc_id) return false
  if (!earlier.ended_at) return false
  const gapMs =
    new Date(later.started_at).getTime() - new Date(earlier.ended_at).getTime()
  return gapMs >= 0 && gapMs <= SESSION_MERGE_GAP_MS
}

/**
 * Sessions newest-first, joined with the account and PC names the admin panel
 * shows. Rows whose account or PC row is gone still list (empty name) rather
 * than vanishing from the history.
 *
 * Consecutive fragments from historical mode-switch splits are merged into one
 * visit row before the limit is applied.
 */
export function listSessions(filter: AdminSessionFilter = {}): SessionRowWithNames[] {
  const limit = clampLimit(filter.limit ?? 50)
  // Pull extra raw rows so merging still fills a full page of visits.
  const fetchLimit = clampLimit(Math.min(500, limit * 4), 500)
  const params: unknown[] = []
  let where = ''
  if (filter.accountId) {
    where = 'WHERE s.account_id = ?'
    params.push(filter.accountId)
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, s.pc_id, s.mode, s.started_at, s.ended_at,
              s.seconds_used, s.centavos_used, s.ended_reason,
              COALESCE(a.username, '') AS username,
              COALESCE(a.display_name, '') AS display_name,
              COALESCE(p.name, '') AS pc_name
         FROM sessions s
         LEFT JOIN accounts a ON a.id = s.account_id
         LEFT JOIN pcs p ON p.id = s.pc_id
         ${where}
        ORDER BY s.started_at DESC
        LIMIT ?`
    )
    .all(...params, fetchLimit) as SessionRowWithNames[]
  return mergeFragmentedSessions(rows).slice(0, limit)
}

// ---- Ledger ----

export function insertLedger(row: Omit<LedgerRow, 'seq'> & { seq?: number }): LedgerRow {
  const seq = row.seq ?? nextSeq()
  const full: LedgerRow = { ...row, seq }
  db.prepare(
    `INSERT OR IGNORE INTO credit_ledger (id, account_id, admin_id, kind, delta_centavos, delta_seconds, note, created_at, synced_from, seq)
     VALUES (@id, @account_id, @admin_id, @kind, @delta_centavos, @delta_seconds, @note, @created_at, @synced_from, @seq)`
  ).run(full)
  return full
}

/** Guards against a renderer asking for an unbounded page. */
function clampLimit(limit: number, max = 500): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(max, Math.max(1, Math.round(limit)))
}

/**
 * One page of ledger rows, newest first, joined with the account username and
 * the acting admin's username (null for customer-driven movements). `total` is
 * the row count matching the same filter so the caller can page.
 *
 * `seq` orders the rows rather than `created_at`: it is monotonic per PC and so
 * immune to clock changes, and it breaks ties within the same second.
 */
export function listLedger(filter: AdminLedgerFilter = {}): {
  rows: LedgerRowWithNames[]
  total: number
  limit: number
  offset: number
} {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.accountId) {
    conditions.push('l.account_id = ?')
    params.push(filter.accountId)
  }
  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`l.kind IN (${filter.kinds.map(() => '?').join(', ')})`)
    params.push(...filter.kinds)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM credit_ledger l ${where}`).get(...params) as {
      c: number
    }
  ).c

  const limit = clampLimit(filter.limit ?? 50)
  const offset = Math.max(0, Math.round(filter.offset ?? 0))
  const rows = db
    .prepare(
      `SELECT l.id, l.account_id, l.admin_id, l.kind, l.delta_centavos, l.delta_seconds,
              l.note, l.created_at, l.synced_from, l.seq,
              COALESCE(a.username, '') AS username,
              COALESCE(a.display_name, '') AS display_name,
              adm.username AS admin_username
         FROM credit_ledger l
         LEFT JOIN accounts a ON a.id = l.account_id
         LEFT JOIN accounts adm ON adm.id = l.admin_id
         ${where}
        ORDER BY l.seq DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as LedgerRowWithNames[]

  return { rows, total, limit, offset }
}

/** Kinds that must be loaded together so timed-visit buy/sell can net into play. */
const TIMED_VISIT_KINDS = ['buy_time', 'sell_time', 'session'] as const

/**
 * Expand a kind filter so summarization still sees the rows it needs to merge
 * (e.g. filtering "session"/Play still loads buy_time + sell_time).
 */
function kindsForSummarize(kinds: LedgerKind[] | undefined): LedgerKind[] | null {
  if (!kinds || kinds.length === 0) return null
  const set = new Set<string>(kinds)
  if (kinds.some((k) => (TIMED_VISIT_KINDS as readonly string[]).includes(k))) {
    for (const k of TIMED_VISIT_KINDS) set.add(k)
  }
  return [...set] as LedgerKind[]
}

/**
 * Collapse consecutive per-account `session` / `open_time` ticks (gap-and-islands),
 * then net timed-visit `buy_time`/`sell_time` into the play summary. Paging `total`
 * counts summarized rows, not raw ticks.
 */
export function listLedgerSummarized(filter: AdminLedgerFilter = {}): {
  rows: LedgerRowWithNames[]
  total: number
  limit: number
  offset: number
} {
  const fetchKinds = kindsForSummarize(filter.kinds)
  const collapsed = loadLedgerIslands(filter.accountId, fetchKinds)
  const summarized = mergeTimedVisitNoise(collapsed)

  const wanted = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null
  const filtered = wanted ? summarized.filter((r) => wanted.has(r.kind)) : summarized

  const limit = clampLimit(filter.limit ?? 50)
  const offset = Math.max(0, Math.round(filter.offset ?? 0))
  return {
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset
  }
}

/** SQL gap-and-islands: one row per contiguous session/open_time burst (and each other kind). */
function loadLedgerIslands(
  accountId: string | undefined,
  kinds: LedgerKind[] | null
): LedgerRowWithNames[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (accountId) {
    conditions.push('l.account_id = ?')
    params.push(accountId)
  }
  if (kinds && kinds.length > 0) {
    conditions.push(`l.kind IN (${kinds.map(() => '?').join(', ')})`)
    params.push(...kinds)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  return db
    .prepare(
      `WITH filtered AS (
         SELECT l.id, l.account_id, l.admin_id, l.kind, l.delta_centavos, l.delta_seconds,
                l.note, l.created_at, l.synced_from, l.seq,
                COALESCE(a.username, '') AS username,
                COALESCE(a.display_name, '') AS display_name,
                adm.username AS admin_username
           FROM credit_ledger l
           LEFT JOIN accounts a ON a.id = l.account_id
           LEFT JOIN accounts adm ON adm.id = l.admin_id
           ${where}
       ),
       marked AS (
         SELECT *,
                CASE
                  WHEN kind IN ('session', 'open_time')
                   AND kind = LAG(kind) OVER (PARTITION BY account_id ORDER BY seq)
                  THEN 0
                  ELSE 1
                END AS new_grp
           FROM filtered
       ),
       island AS (
         SELECT *,
                SUM(new_grp) OVER (PARTITION BY account_id ORDER BY seq) AS grp
           FROM marked
       ),
       agg AS (
         SELECT account_id, kind, grp,
                SUM(delta_centavos) AS delta_centavos,
                SUM(delta_seconds) AS delta_seconds,
                MIN(created_at) AS created_at,
                MIN(seq) AS min_seq,
                MAX(seq) AS max_seq
           FROM island
          GROUP BY account_id, kind, grp
       )
       SELECT first.id,
              agg.account_id,
              first.admin_id,
              agg.kind,
              agg.delta_centavos,
              agg.delta_seconds,
              CASE
                WHEN agg.kind = 'session' THEN 'timed play'
                WHEN agg.kind = 'open_time' THEN 'open time'
                ELSE first.note
              END AS note,
              agg.created_at,
              first.synced_from,
              agg.max_seq AS seq,
              first.username,
              first.display_name,
              first.admin_username
         FROM agg
         JOIN island first
           ON first.account_id = agg.account_id
          AND first.grp = agg.grp
          AND first.seq = agg.min_seq
        ORDER BY agg.max_seq DESC`
    )
    .all(...params) as LedgerRowWithNames[]
}

/**
 * Per account (seq ascending): fold buy_time / session / sell_time of one timed
 * visit into a single Play row. Pure canceling convert pairs with no play are hidden.
 */
function mergeTimedVisitNoise(rows: LedgerRowWithNames[]): LedgerRowWithNames[] {
  const byAccount = new Map<string, LedgerRowWithNames[]>()
  for (const row of rows) {
    const list = byAccount.get(row.account_id)
    if (list) list.push(row)
    else byAccount.set(row.account_id, [row])
  }

  const out: LedgerRowWithNames[] = []
  for (const list of byAccount.values()) {
    list.sort((a, b) => a.seq - b.seq)
    out.push(...mergeAccountTimedVisits(list))
  }
  out.sort((a, b) => b.seq - a.seq)
  return out
}

function mergeAccountTimedVisits(rows: LedgerRowWithNames[]): LedgerRowWithNames[] {
  const out: LedgerRowWithNames[] = []
  let buys: LedgerRowWithNames[] = []
  let sessions: LedgerRowWithNames[] = []

  const flushTimed = (sell?: LedgerRowWithNames): void => {
    if (sessions.length === 0 && buys.length === 0 && !sell) return

    if (sessions.length === 0) {
      const parts = sell ? [...buys, sell] : [...buys]
      const netC = parts.reduce((s, r) => s + r.delta_centavos, 0)
      const netS = parts.reduce((s, r) => s + r.delta_seconds, 0)
      if (parts.length >= 2 && netC === 0 && netS === 0) {
        // buy+sell canceled with no play — drop the noise
      } else if (sell && buys.length > 0) {
        if (netC !== 0 || netS !== 0) {
          const earliest = parts.reduce((a, b) => (a.seq < b.seq ? a : b))
          out.push({
            ...earliest,
            kind: netC <= 0 ? 'buy_time' : 'sell_time',
            delta_centavos: netC,
            delta_seconds: netS,
            note: 'time convert',
            created_at: earliest.created_at,
            seq: Math.max(...parts.map((r) => r.seq)),
            admin_id: null,
            admin_username: null
          })
        }
      } else {
        out.push(...buys)
        if (sell) out.push(sell)
      }
      buys = []
      sessions = []
      return
    }

    const parts = sell ? [...buys, ...sessions, sell] : [...buys, ...sessions]
    const earliest = parts.reduce((a, b) => (a.seq < b.seq ? a : b))
    const base = sessions[0]
    out.push({
      ...base,
      id: earliest.id,
      kind: 'session',
      delta_centavos: parts.reduce((s, r) => s + r.delta_centavos, 0),
      delta_seconds: sessions.reduce((s, r) => s + r.delta_seconds, 0),
      note: 'timed play',
      created_at: earliest.created_at,
      seq: Math.max(...parts.map((r) => r.seq)),
      admin_id: null,
      admin_username: null
    })
    buys = []
    sessions = []
  }

  for (const row of rows) {
    if (row.kind === 'buy_time') {
      buys.push(row)
    } else if (row.kind === 'session') {
      sessions.push(row)
    } else if (row.kind === 'sell_time') {
      flushTimed(row)
    } else {
      flushTimed()
      out.push(row)
    }
  }
  flushTimed()
  return out
}

// ---- Dashboard aggregates ----
//
// `created_at` is an ISO-8601 UTC string, so `substr(created_at, 1, 10)` is the
// UTC calendar day and compares correctly against SQLite's `date('now')` (also
// UTC). Day boundaries are therefore UTC, not Manila time: a top-up taken after
// 08:00 PHT lands on the same day, one taken before 08:00 counts as "yesterday".
// Acceptable for a single-shop dashboard; a local-day version would need the
// shop's offset threaded through from settings.

export interface LedgerTotals {
  revenueTodayCentavos: number
  revenueWeekCentavos: number
  openTimeSpendTodayCentavos: number
  timeSoldTodaySeconds: number
}

/** Today's / this week's money movements, as four SQL aggregates. */
export function ledgerTotals(): LedgerTotals {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'topup' AND delta_centavos > 0
                            AND substr(created_at, 1, 10) = date('now')
                           THEN delta_centavos END), 0) AS revenue_today,
         COALESCE(SUM(CASE WHEN kind = 'topup' AND delta_centavos > 0
                            AND substr(created_at, 1, 10) >= date('now', '-6 days')
                           THEN delta_centavos END), 0) AS revenue_week,
         COALESCE(SUM(CASE WHEN kind = 'open_time'
                            AND substr(created_at, 1, 10) = date('now')
                           THEN ABS(delta_centavos) END), 0) AS open_time_today,
         COALESCE(SUM(CASE WHEN kind = 'buy_time' AND delta_seconds > 0
                            AND substr(created_at, 1, 10) = date('now')
                           THEN delta_seconds END), 0) AS time_sold_today
       FROM credit_ledger`
    )
    .get() as {
    revenue_today: number
    revenue_week: number
    open_time_today: number
    time_sold_today: number
  }
  return {
    revenueTodayCentavos: row.revenue_today,
    revenueWeekCentavos: row.revenue_week,
    openTimeSpendTodayCentavos: row.open_time_today,
    timeSoldTodaySeconds: row.time_sold_today
  }
}

export interface AccountTotals {
  accountCount: number
  totalOutstandingCentavos: number
  totalOutstandingTimeSeconds: number
}

/** Account count and the unspent balances held across all accounts. */
export function accountTotals(): AccountTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS accounts,
              COALESCE(SUM(credits_centavos), 0) AS centavos,
              COALESCE(SUM(time_balance_seconds), 0) AS seconds
         FROM accounts`
    )
    .get() as { accounts: number; centavos: number; seconds: number }
  return {
    accountCount: row.accounts,
    totalOutstandingCentavos: row.centavos,
    totalOutstandingTimeSeconds: row.seconds
  }
}

export function countActiveSessions(): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM sessions WHERE ended_at IS NULL')
    .get() as { c: number }
  return row.c
}

/**
 * Top-up revenue grouped by UTC day for the last 7 days. Days with no top-ups
 * are simply absent; the caller zero-fills so the chart always has 7 bars.
 */
export function dailyTopupRevenue(): AdminDailyRevenue[] {
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(delta_centavos), 0) AS centavos
         FROM credit_ledger
        WHERE kind = 'topup'
          AND delta_centavos > 0
          AND substr(created_at, 1, 10) >= date('now', '-6 days')
        GROUP BY day
        ORDER BY day ASC`
    )
    .all() as AdminDailyRevenue[]
}

// ---- Sync queue ----

export function enqueue(kind: SyncQueueItem['kind'], payload: unknown): SyncQueueItem {
  const item: SyncQueueItem = {
    id: randomUUID(),
    kind,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    seq: nextSeq(),
    attempts: 0,
    last_error: null
  }
  db.prepare(
    `INSERT INTO sync_queue (id, kind, payload, created_at, seq, attempts, last_error)
     VALUES (@id, @kind, @payload, @created_at, @seq, @attempts, @last_error)`
  ).run(item)
  return item
}

export function peekQueue(limit = 100): SyncQueueItem[] {
  return db
    .prepare('SELECT * FROM sync_queue ORDER BY seq ASC LIMIT ?')
    .all(limit) as SyncQueueItem[]
}

export function queueCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sync_queue').get() as { c: number }
  return row.c
}

export function removeQueued(id: string): void {
  db.prepare('DELETE FROM sync_queue WHERE id = ?').run(id)
}

export function markQueueError(id: string, error: string): void {
  db.prepare('UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(
    error,
    id
  )
}

export function updateQueuedPayload(id: string, payload: unknown): void {
  db.prepare('UPDATE sync_queue SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id)
}

/** True if the queue still has unsent ops that change this account's balances. */
export function hasPendingMoneyOps(accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sync_queue
        WHERE kind IN (
          'sell_time', 'buy_time', 'session_time', 'session_tick', 'session_credits',
          'admin_add_credits', 'admin_grant_time', 'admin_adjust'
        )
          AND json_extract(payload, '$.account_id') = ?
        LIMIT 1`
    )
    .get(accountId) as { ok: number } | undefined
  return !!row
}
