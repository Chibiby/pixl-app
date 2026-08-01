// Shared domain + IPC types used by main, preload, and renderer.

export type AccountRole = 'client' | 'admin'
export type PcStatus = 'locked' | 'in_session' | 'offline'
export type SessionEndedReason =
  | 'logout'
  | 'time_exhausted'
  | 'credits_exhausted'
  | 'shutdown'
  | 'admin'
export type LedgerSource = 'server' | 'offline_queue'

/**
 * How a session is paid for:
 *  - 'timed': counts down temporary session time (`time_balance_seconds`).
 *  - 'open':  burns the money balance (`credits_centavos`) continuously.
 *
 * Credits are the persisted customer balance. `time_balance_seconds` is only a
 * temporary countdown during an active timed session; unused time converts back
 * to credits on logout.
 */
export type SessionMode = 'timed' | 'open'

/**
 * Every balance movement is one ledger row:
 *  - 'topup'     admin adds money            (+centavos)
 *  - 'buy_time'  credits → session time      (-centavos, +seconds)
 *  - 'sell_time' unused session time → credits (+centavos, -seconds)
 *  - 'open_time' open-time play burns money  (-centavos)
 *  - 'session'   timed play burns time       (-seconds)
 *  - 'grant'     legacy admin raw-time grant (+seconds; not offered in admin UI)
 *  - 'adjust'    manual/legacy correction
 */
export type LedgerKind =
  | 'topup'
  | 'buy_time'
  | 'sell_time'
  | 'open_time'
  | 'session'
  | 'grant'
  | 'adjust'

export interface Account {
  id: string
  username: string
  password_hash: string
  role: AccountRole
  /** Persisted money balance in centavos (integer). */
  credits_centavos: number
  /**
   * Temporary timed-session countdown in seconds. Not a saved account balance —
   * converts back to credits when the session ends.
   */
  time_balance_seconds: number
  display_name: string
  created_at: string
  updated_at: string
}

/** Account row as safe to expose to the renderer (no hash). */
export interface AccountPublic {
  id: string
  username: string
  role: AccountRole
  credits_centavos: number
  time_balance_seconds: number
  display_name: string
  created_at: string
  updated_at: string
}

export interface Pc {
  id: string
  machine_id: string
  name: string
  last_seen_at: string | null
  current_account_id: string | null
  status: PcStatus
}

export interface SessionRow {
  id: string
  account_id: string
  pc_id: string
  mode: SessionMode
  started_at: string
  ended_at: string | null
  seconds_used: number
  /** Money burned by an open-time session (always 0 for timed sessions). */
  centavos_used: number
  ended_reason: SessionEndedReason | null
}

/**
 * Unified money + time ledger. A row carries a centavo delta, a seconds delta,
 * or both ('buy_time'), so a single monotonic `seq` orders every movement.
 */
export interface LedgerRow {
  id: string
  account_id: string
  admin_id: string | null
  kind: LedgerKind
  delta_centavos: number
  delta_seconds: number
  note: string | null
  created_at: string
  synced_from: LedgerSource
  seq: number
}

export type AppMode = 'lockscreen' | 'session' | 'admin'

/**
 * Short-lived open→timed handoff: lockscreen can resume without re-auth.
 * Set by main when switching from an open session into the timed chooser.
 */
export interface PendingResume {
  account: AccountPublic
  fromMode: 'open'
}

/** The mode snapshot broadcast to every renderer window. */
export interface ModeState {
  mode: AppMode
  online: boolean
  account: AccountPublic | null
  message: string | null // e.g. "No credits — please top up at the counter"
  session: SessionSnapshot | null
  pc: { machineId: string; name: string; idleShutdownSeconds: number } | null
  /** Present while waiting for buy-time after open→timed switch. */
  pendingResume?: PendingResume | null
  /**
   * Epoch ms when the timed chooser (0 minutes, pick credits→time) auto-locks.
   * Null when not in a chooser handoff.
   */
  chooserDeadlineAt?: number | null
}

/** Live session data pushed to the tray popover roughly once a second. */
export interface SessionSnapshot {
  accountId: string
  displayName: string
  username: string
  mode: SessionMode
  secondsUsedThisSession: number
  /** Money balance left on the account, in centavos. */
  creditsCentavos: number
  /** Purchased time left on the account, in seconds. */
  timeBalanceSeconds: number
  /** Whole centavos already burned by this open-time session (0 when timed). */
  spentCentavos: number
  /** Runway: purchased time (timed) or credits valued in seconds (open). */
  secondsRemaining: number
}

export type LoginOutcome =
  | 'ok'
  | 'no_credits'
  /** Timed session requested with no time balance — buy time to start. */
  | 'needs_time'
  | 'invalid_credentials'
  | 'in_use_elsewhere'
  | 'admin_ok'
  | 'error'

export interface LoginResult {
  outcome: LoginOutcome
  message: string
  account: AccountPublic | null
}

export type SwitchModeOutcome = 'ok' | 'needs_time' | 'no_credits' | 'error'

export interface SwitchModeResult {
  outcome: SwitchModeOutcome
  message: string
  account: AccountPublic | null
}

export interface AdminAddCreditsInput {
  accountId: string
  /** Peso amount to add to the money balance; may include centavos (e.g. 1.5). */
  pesos?: number
  /**
   * Legacy compatibility: raw time grant (no money movement). Admin UI no longer
   * exposes this — credits are the only persisted balance staff manage.
   */
  grantMinutes?: number
  note?: string
}

export interface BuyTimeInput {
  /** Defaults to the account of the active session. */
  accountId?: string
  /** Money to convert into time, in centavos. */
  centavos: number
}

export type BuyTimeOutcome =
  | 'ok'
  | 'insufficient_credits'
  | 'invalid_amount'
  | 'no_account'
  | 'error'

export interface BuyTimeResult {
  outcome: BuyTimeOutcome
  message: string
  account: AccountPublic | null
  addedSeconds: number
  session: SessionSnapshot | null
}

export interface CreateAccountInput {
  username: string
  password: string
  displayName: string
  role: AccountRole
  /** Opening money balance in pesos. */
  initialPesos?: number
}

/** Profile edit from the admin panel. Balances are never touched here. */
export interface AdminUpdateAccountInput {
  accountId: string
  displayName?: string
  role?: AccountRole
  /** When present the local bcrypt hash is replaced (password reset). */
  newPassword?: string
}

/**
 * Signed credit correction. Deltas may be negative and are clamped at zero so
 * the ledger records what actually moved. `deltaMinutes` remains for backend
 * compatibility but is not offered in the admin UI.
 */
export interface AdminAdjustBalanceInput {
  accountId: string
  deltaPesos?: number
  /** @deprecated Admin UI is credits-only; kept for IPC compatibility. */
  deltaMinutes?: number
  /** Required: an adjustment without a reason is unauditable. */
  note: string
}

/** Ledger row decorated with the names the admin panel displays. */
export interface LedgerRowWithNames extends LedgerRow {
  username: string
  display_name: string
  /** Username of the acting admin, null for customer-driven movements. */
  admin_username: string | null
}

export interface AdminLedgerFilter {
  accountId?: string
  kinds?: LedgerKind[]
  limit?: number
  offset?: number
}

/** One page of ledger rows plus the total matching the filter, for paging. */
export interface AdminLedgerPage {
  rows: LedgerRowWithNames[]
  total: number
  limit: number
  offset: number
}

/** Session row decorated with the account and PC names. */
export interface SessionRowWithNames extends SessionRow {
  username: string
  display_name: string
  pc_name: string
}

export interface AdminSessionFilter {
  accountId?: string
  limit?: number
}

/** One bar of the dashboard revenue chart (UTC day). */
export interface AdminDailyRevenue {
  /** 'YYYY-MM-DD' */
  day: string
  centavos: number
}

/** Dashboard aggregates. Every figure is computed by SQL, never in JS. */
export interface AdminStats {
  revenueTodayCentavos: number
  revenueWeekCentavos: number
  /** Money burned by open-time play today (positive number). */
  openTimeSpendTodayCentavos: number
  /** Still computed server-side; admin dashboard no longer surfaces this. */
  timeSoldTodaySeconds: number
  activeSessions: number
  pcs: Pc[]
  accountCount: number
  /** Unspent money held on accounts — the shop's liability. */
  totalOutstandingCentavos: number
  /** Still computed server-side; not a persisted customer balance to manage. */
  totalOutstandingTimeSeconds: number
  /** Oldest to newest, always 7 entries (missing days are zero-filled). */
  dailyRevenue: AdminDailyRevenue[]
  generatedAt: string
}

export interface AppSettings {
  pesoToSecondsRate: number // seconds granted per ₱1 (default 360 = 6 min)
  idleShutdownSeconds: number // 0 = disabled
  reminderThresholdsSeconds: number[] // e.g. [300, 60]
  isAdminMachine: boolean
}

export interface SyncStatus {
  online: boolean
  pendingCount: number
  lastSyncAt: string | null
  lastError: string | null
}

/** electron-updater lifecycle as shown in the admin panel. */
export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** From app.getVersion() / package.json version. */
  currentVersion: string
  availableVersion: string | null
  downloadPercent: number | null
  message: string | null
}
