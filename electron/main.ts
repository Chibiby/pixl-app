import { app, ipcMain, Tray, nativeImage, Menu, nativeTheme } from 'electron'
import { IPC } from '@shared/ipc'
import { appIcon } from './assets'
import type {
  AdminAddCreditsInput,
  AdminAdjustBalanceInput,
  AdminLedgerFilter,
  AdminSessionFilter,
  AdminUpdateAccountInput,
  AppSettings,
  BuyTimeInput,
  CreateAccountInput,
  LoginResult,
  SessionMode
} from '@shared/types'
import { getRuntimeConfig } from './config'
import { initDb } from './sync/sqlite'
import { getSettings, updateSettings } from './settings'
import { attemptLogin } from './auth'
import { AppController } from './appController'
import { purchaseTime } from './credits'
import {
  adminAddCredits,
  adminAdjustBalance,
  adminCreateAccount,
  adminDeleteAccount,
  adminGetStats,
  adminListAccounts,
  adminListLedger,
  adminListPcs,
  adminListSessions,
  adminUpdateAccount
} from './admin'
import {
  forceSync,
  getSyncStatus,
  onSyncStatus,
  setSessionResolver,
  setStatusProvider,
  startReconciler,
  stopReconciler
} from './sync/reconciler'
import { initKeyboardHook, disposeKeyboardHook } from './keyboardHook'
import { registerStartup } from './startup'
import { ensureWatchdogProtection } from './watchdog'
import {
  checkForUpdates,
  getUpdateStatus,
  initUpdater,
  installUpdateNow
} from './updater'

// Kiosk resilience: never let an unhandled error tear the process down. The
// watchdog would relaunch it, but staying up is better than a relaunch flicker.
process.on('unhandledRejection', (reason) => {
  console.error('[pixl] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[pixl] uncaughtException:', err)
})

// Single-instance lock: a second launch (e.g. from the watchdog after the first
// is already alive) should not spawn a duplicate kiosk.
// Must not run whenReady / ensureWatchdogProtection on the secondary — that
// would clear maintenance.stop while an admin quit is in flight and let the
// watchdog relaunch immediately.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let controller: AppController
let tray: Tray | null = null

function createTray(): void {
  const branded = appIcon()
  const image = branded.isEmpty()
    ? nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      )
    : branded.resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('Pixl')
  tray.on('click', (_e, bounds) => controller.toggleTrayPopover(bounds))
  const menu = Menu.buildFromTemplate([
    { label: 'Show session', click: () => controller.toggleTrayPopover(tray?.getBounds()) }
  ])
  tray.setContextMenu(menu)
  controller.setTray(tray)
}

function registerIpc(): void {
  ipcMain.handle(
    IPC.login,
    async (
      _e,
      username: string,
      password: string,
      mode: SessionMode = 'timed',
      purchaseCentavos = 0
    ): Promise<LoginResult> => {
      const { result, serverSessionId } = await attemptLogin(
        username,
        password,
        mode,
        purchaseCentavos
      )
      // Only `ok` starts a client session. Outcomes like `no_credits`,
      // `needs_time`, `invalid_credentials`, etc. must never call startClientSession.
      if (result.outcome === 'ok' && result.account) {
        // A timed session may be started with a top-up in the same call, so the
        // purchase has to land before the session snapshots the balances.
        let account = result.account
        if (mode === 'timed' && purchaseCentavos > 0) {
          const bought = purchaseTime(account.id, purchaseCentavos)
          if (bought.outcome !== 'ok' || !bought.account) {
            return { outcome: 'error', message: bought.message, account }
          }
          account = bought.account
        }
        controller.startClientSession(account, mode, serverSessionId)
      } else if (result.outcome === 'admin_ok' && result.account) {
        controller.enterAdmin(result.account)
      } else if (result.outcome === 'needs_time' && result.account) {
        // Park on the timed chooser with a 2-minute auto-lock countdown.
        // Already on lockscreen — beginTimedChooser will not tear down the form window.
        controller.beginTimedChooser(result.account)
      }
      // no_credits / invalid_credentials / in_use_elsewhere: leave the lockscreen
      // form up so it can show the message inline (re-entering would destroy it).
      return result
    }
  )

  ipcMain.handle(IPC.buyTime, (_e, input: BuyTimeInput) => controller.buyTime(input))

  ipcMain.handle(IPC.switchMode, (_e, mode: SessionMode) => {
    const result = controller.switchMode(mode)
    // timed→open queues sell_time; drain promptly like logout.
    if (result.outcome !== 'error') void forceSync()
    return result
  })

  ipcMain.handle(IPC.resumeTimed, (_e, purchaseCentavos = 0) => {
    const result = controller.resumeTimed(purchaseCentavos)
    if (result.outcome === 'ok') void forceSync()
    return result
  })

  ipcMain.handle(IPC.cancelPendingResume, () => {
    controller.cancelPendingResume()
  })

  ipcMain.handle(IPC.logout, (_e, _reason?: string) => {
    controller.logout('logout')
    // Prompt heartbeat so the server closes the session right away.
    void forceSync()
  })

  ipcMain.handle(IPC.adminLogout, () => {
    controller.logout('admin')
    void forceSync()
  })

  ipcMain.handle(IPC.getModeState, () => controller.getModeState())
  ipcMain.handle(IPC.getSettings, () => getSettings())
  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    controller.broadcastState()
    return next
  })

  ipcMain.handle(IPC.adminListAccounts, () => adminListAccounts())
  ipcMain.handle(IPC.adminCreateAccount, (_e, input: CreateAccountInput) =>
    adminCreateAccount(input)
  )
  ipcMain.handle(IPC.adminUpdateAccount, (_e, input: AdminUpdateAccountInput) => {
    const admin = controller.getAdminAccount()
    return adminUpdateAccount(input, admin?.id ?? null)
  })
  ipcMain.handle(IPC.adminDeleteAccount, (_e, accountId: string) => {
    const admin = controller.getAdminAccount()
    return adminDeleteAccount(accountId, admin?.id ?? null)
  })
  ipcMain.handle(IPC.adminAddCredits, (_e, input: AdminAddCreditsInput) => {
    const admin = controller.getAdminAccount()
    return adminAddCredits(input, admin?.id ?? null)
  })
  ipcMain.handle(IPC.adminAdjustBalance, (_e, input: AdminAdjustBalanceInput) => {
    const admin = controller.getAdminAccount()
    return adminAdjustBalance(input, admin?.id ?? null)
  })
  ipcMain.handle(IPC.adminListPcs, () => adminListPcs())
  ipcMain.handle(IPC.adminListSessions, (_e, filter?: number | AdminSessionFilter) =>
    adminListSessions(filter ?? {})
  )
  ipcMain.handle(IPC.adminListLedger, (_e, filter?: AdminLedgerFilter) =>
    adminListLedger(filter ?? {})
  )
  ipcMain.handle(IPC.adminGetStats, () => adminGetStats())
  ipcMain.handle(IPC.adminQuitApp, () => {
    controller.requestAdminQuit()
  })

  ipcMain.handle(IPC.getSyncStatus, () => getSyncStatus())
  ipcMain.handle(IPC.forceSync, () => forceSync())

  ipcMain.handle(IPC.getUpdateStatus, () => getUpdateStatus())
  ipcMain.handle(IPC.checkForUpdates, () => checkForUpdates({ autoInstall: false }))
  ipcMain.handle(IPC.installUpdate, () => installUpdateNow())
}

if (gotLock) {
  app.on('second-instance', () => {
    // Bring lockscreen back to front if a duplicate tried to launch.
    controller?.broadcastState()
  })

  app.whenReady().then(() => {
    // Dev safety: never shut the machine down while developing.
    if (!app.isPackaged) process.env.PIXL_NO_SHUTDOWN = '1'

    // Kiosk UI: no application menu (removes the File/Edit/View/Window bar on the
    // admin window) and dark native title bars to match the app theme.
    Menu.setApplicationMenu(null)
    nativeTheme.themeSource = 'dark'

    initDb()
    const cfg = getRuntimeConfig()
    console.log(`[pixl] starting on PC "${cfg.pcName}" (supabase=${cfg.hasSupabase})`)

    controller = new AppController()
    initUpdater({
      isSafeToAutoInstall: () => controller.isSafeToAutoInstallUpdate(),
      prepareForInstall: () => controller.prepareForUpdateInstall()
    })
    registerIpc()
    initKeyboardHook()
    createTray()
    controller.init()

    registerStartup()
    ensureWatchdogProtection()

    onSyncStatus((status) => {
      controller.setOnline(status.online)
      controller.broadcastState()
    })
    // Wire the reconciler to the live app state: heartbeats must report the real
    // PC status (a wrong 'locked' heartbeat would close the server session), and
    // queued offline debits need the current server session id.
    setStatusProvider(() => controller.getPcStatusForHeartbeat())
    setSessionResolver((accountId) => controller.getServerSessionFor(accountId))
    startReconciler()
  })

  app.on('window-all-closed', () => {
    // Kiosk: subscribing to this event overrides the default auto-quit. We only
    // quit when an admin used the maintenance quit path (allowQuit); otherwise we
    // stay alive (lock windows get recreated).
    if (controller?.isAllowQuit()) {
      stopReconciler()
      disposeKeyboardHook()
      app.quit()
    }
  })

  app.on('before-quit', () => {
    stopReconciler()
    disposeKeyboardHook()
  })
}
