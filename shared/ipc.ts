// Central registry of IPC channel names and the shape of the preload-exposed API.
// Keeping this in one shared file guarantees main, preload, and renderer stay in sync.

import type {
  AccountPublic,
  AdminAddCreditsInput,
  AdminAdjustBalanceInput,
  AdminLedgerFilter,
  AdminLedgerPage,
  AdminSessionFilter,
  AdminStats,
  AdminUpdateAccountInput,
  AppSettings,
  BuyTimeInput,
  BuyTimeResult,
  CreateAccountInput,
  LoginResult,
  ModeState,
  Pc,
  SessionMode,
  SessionRowWithNames,
  SessionSnapshot,
  SwitchModeResult,
  SyncStatus,
  UpdateStatus
} from './types'

export const IPC = {
  // renderer -> main (invoke/handle)
  login: 'auth:login',
  logout: 'auth:logout',
  adminLogout: 'admin:logout',
  buyTime: 'session:buyTime',
  switchMode: 'session:switchMode',
  resumeTimed: 'session:resumeTimed',
  cancelPendingResume: 'session:cancelPendingResume',
  getModeState: 'mode:get',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  // admin operations
  adminListAccounts: 'admin:listAccounts',
  adminCreateAccount: 'admin:createAccount',
  adminUpdateAccount: 'admin:updateAccount',
  adminDeleteAccount: 'admin:deleteAccount',
  adminAddCredits: 'admin:addCredits',
  adminAdjustBalance: 'admin:adjustBalance',
  adminListPcs: 'admin:listPcs',
  adminListSessions: 'admin:listSessions',
  adminListLedger: 'admin:listLedger',
  adminGetStats: 'admin:getStats',
  adminQuitApp: 'admin:quitApp',
  getSyncStatus: 'sync:status',
  forceSync: 'sync:force',
  getUpdateStatus: 'update:status',
  checkForUpdates: 'update:check',
  installUpdate: 'update:install',

  // main -> renderer (send/on)
  onModeState: 'mode:state',
  onSessionTick: 'session:tick',
  onSyncStatus: 'sync:statusChanged',
  onUpdateStatus: 'update:statusChanged'
} as const

/** The typed surface exposed on `window.pixl` from preload. */
export interface PixlApi {
  /**
   * `purchaseCentavos` lets a timed session be started with a top-up in the
   * same round trip (used when the account has time balance 0 but has money).
   */
  login(
    username: string,
    password: string,
    mode: SessionMode,
    purchaseCentavos?: number
  ): Promise<LoginResult>
  logout(reason?: string): Promise<void>
  adminLogout(): Promise<void>
  /** Convert money into play time; usable mid-session. */
  buyTime(input: BuyTimeInput): Promise<BuyTimeResult>
  /** Mid-session Timed ↔ Open; open→timed may park on lockscreen with pendingResume. */
  switchMode(mode: SessionMode): Promise<SwitchModeResult>
  /** Continue a pending open→timed resume, optionally buying time first. */
  resumeTimed(purchaseCentavos?: number): Promise<LoginResult>
  /** Drop pendingResume and stay on the lockscreen. */
  cancelPendingResume(): Promise<void>
  getModeState(): Promise<ModeState>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  adminListAccounts(): Promise<AccountPublic[]>
  adminCreateAccount(input: CreateAccountInput): Promise<AccountPublic>
  /** Profile only (display name / role / password); never moves balances. */
  adminUpdateAccount(input: AdminUpdateAccountInput): Promise<AccountPublic>
  /** Permanently remove an account (local delete; server RPC not deployed). */
  adminDeleteAccount(accountId: string): Promise<void>
  /** Top-up: positive money (and optional free time), ledger kind 'topup'/'grant'. */
  adminAddCredits(input: AdminAddCreditsInput): Promise<AccountPublic>
  /** Signed correction of either balance, ledger kind 'adjust'. */
  adminAdjustBalance(input: AdminAdjustBalanceInput): Promise<AccountPublic>
  adminListPcs(): Promise<Pc[]>
  /** A bare number is still accepted and read as the row limit. */
  adminListSessions(filter?: number | AdminSessionFilter): Promise<SessionRowWithNames[]>
  adminListLedger(filter?: AdminLedgerFilter): Promise<AdminLedgerPage>
  adminGetStats(): Promise<AdminStats>
  adminQuitApp(): Promise<void>

  getSyncStatus(): Promise<SyncStatus>
  forceSync(): Promise<SyncStatus>

  getUpdateStatus(): Promise<UpdateStatus>
  /** Manual check from admin; downloads quietly when an update exists. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Quit and install a downloaded update (admin "Update now"). */
  installUpdate(): Promise<UpdateStatus>

  onModeState(cb: (state: ModeState) => void): () => void
  onSessionTick(cb: (snap: SessionSnapshot) => void): () => void
  onSyncStatus(cb: (status: SyncStatus) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

declare global {
  interface Window {
    pixl: PixlApi
  }
}
