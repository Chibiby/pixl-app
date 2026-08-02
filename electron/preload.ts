import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PixlApi } from '@shared/ipc'
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
  SessionRowWithNames,
  SessionSnapshot,
  SwitchModeResult,
  SyncStatus,
  UpdateStatus
} from '@shared/types'

const api: PixlApi = {
  login: (username, password, mode, purchaseCentavos) =>
    ipcRenderer.invoke(
      IPC.login,
      username,
      password,
      mode,
      purchaseCentavos ?? 0
    ) as Promise<LoginResult>,
  logout: (reason) => ipcRenderer.invoke(IPC.logout, reason) as Promise<void>,
  adminLogout: () => ipcRenderer.invoke(IPC.adminLogout) as Promise<void>,
  buyTime: (input: BuyTimeInput) =>
    ipcRenderer.invoke(IPC.buyTime, input) as Promise<BuyTimeResult>,
  switchMode: (mode) =>
    ipcRenderer.invoke(IPC.switchMode, mode) as Promise<SwitchModeResult>,
  resumeTimed: (purchaseCentavos) =>
    ipcRenderer.invoke(IPC.resumeTimed, purchaseCentavos ?? 0) as Promise<LoginResult>,
  cancelPendingResume: () => ipcRenderer.invoke(IPC.cancelPendingResume) as Promise<void>,
  getModeState: () => ipcRenderer.invoke(IPC.getModeState) as Promise<ModeState>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  updateSettings: (patch) =>
    ipcRenderer.invoke(IPC.updateSettings, patch) as Promise<AppSettings>,

  adminListAccounts: () =>
    ipcRenderer.invoke(IPC.adminListAccounts) as Promise<AccountPublic[]>,
  adminCreateAccount: (input: CreateAccountInput) =>
    ipcRenderer.invoke(IPC.adminCreateAccount, input) as Promise<AccountPublic>,
  adminUpdateAccount: (input: AdminUpdateAccountInput) =>
    ipcRenderer.invoke(IPC.adminUpdateAccount, input) as Promise<AccountPublic>,
  adminDeleteAccount: (accountId: string) =>
    ipcRenderer.invoke(IPC.adminDeleteAccount, accountId) as Promise<void>,
  adminAddCredits: (input: AdminAddCreditsInput) =>
    ipcRenderer.invoke(IPC.adminAddCredits, input) as Promise<AccountPublic>,
  adminAdjustBalance: (input: AdminAdjustBalanceInput) =>
    ipcRenderer.invoke(IPC.adminAdjustBalance, input) as Promise<AccountPublic>,
  adminListPcs: () => ipcRenderer.invoke(IPC.adminListPcs) as Promise<Pc[]>,
  adminListSessions: (filter?: number | AdminSessionFilter) =>
    ipcRenderer.invoke(IPC.adminListSessions, filter) as Promise<SessionRowWithNames[]>,
  adminListLedger: (filter?: AdminLedgerFilter) =>
    ipcRenderer.invoke(IPC.adminListLedger, filter) as Promise<AdminLedgerPage>,
  adminGetStats: () => ipcRenderer.invoke(IPC.adminGetStats) as Promise<AdminStats>,
  adminQuitApp: () => ipcRenderer.invoke(IPC.adminQuitApp) as Promise<void>,
  adminGetAppEnabled: () =>
    ipcRenderer.invoke(IPC.adminGetAppEnabled) as Promise<boolean>,
  adminSetAppEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.adminSetAppEnabled, enabled) as Promise<boolean>,

  getSyncStatus: () => ipcRenderer.invoke(IPC.getSyncStatus) as Promise<SyncStatus>,
  forceSync: () => ipcRenderer.invoke(IPC.forceSync) as Promise<SyncStatus>,

  getUpdateStatus: () => ipcRenderer.invoke(IPC.getUpdateStatus) as Promise<UpdateStatus>,
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates) as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate) as Promise<UpdateStatus>,

  onModeState: (cb: (state: ModeState) => void) => {
    const handler = (_e: unknown, state: ModeState): void => cb(state)
    ipcRenderer.on(IPC.onModeState, handler)
    return () => ipcRenderer.removeListener(IPC.onModeState, handler)
  },
  onSessionTick: (cb: (snap: SessionSnapshot) => void) => {
    const handler = (_e: unknown, snap: SessionSnapshot): void => cb(snap)
    ipcRenderer.on(IPC.onSessionTick, handler)
    return () => ipcRenderer.removeListener(IPC.onSessionTick, handler)
  },
  onSyncStatus: (cb: (status: SyncStatus) => void) => {
    const handler = (_e: unknown, status: SyncStatus): void => cb(status)
    ipcRenderer.on(IPC.onSyncStatus, handler)
    return () => ipcRenderer.removeListener(IPC.onSyncStatus, handler)
  },
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const handler = (_e: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on(IPC.onUpdateStatus, handler)
    return () => ipcRenderer.removeListener(IPC.onUpdateStatus, handler)
  }
}

contextBridge.exposeInMainWorld('pixl', api)
