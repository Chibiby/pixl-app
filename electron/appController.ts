import { app, BrowserWindow, screen, Notification } from 'electron'
import type {
  AccountPublic,
  AppMode,
  BuyTimeInput,
  BuyTimeResult,
  LoginResult,
  ModeState,
  Pc,
  SessionEndedReason,
  SessionMode,
  SessionSnapshot,
  SwitchModeResult
} from '@shared/types'
import { IPC } from '@shared/ipc'
import {
  centavosPerSecond,
  centavosToSeconds,
  formatPesos,
  NO_CREDITS_MESSAGE
} from '@shared/money'
import { getRuntimeConfig } from './config'
import { getSettings } from './settings'
import { getMachineIdCached } from './sync/identity'
import {
  adjustCredits,
  adjustTimeBalance,
  createSession,
  endSession,
  enqueue,
  getAccountById,
  getOrCreatePc,
  insertLedger,
  nextSeq,
  setPcStatus,
  toPublic,
  updateSessionMode,
  updateSessionUsage
} from './sync/sqlite'
import { purchaseTime, refundTimeToCredits } from './credits'
import { enterMaintenanceMode, ensureWatchdogProtection } from './watchdog'
import { isAppFullyDisabled, setAppFullyDisabled } from './disable'
import { checkForUpdatesWhenIdle, maybeInstallPendingUpdate } from './updater'
import { SessionTimer } from './session/timer'
import { shutdownWindows } from './shutdown'
import { initKeyboardHook, setKeyboardHookActive } from './keyboardHook'
import {
  cancelSuppressDesktopShell,
  ensureDesktopShell,
  forceShellForeground,
  isPixlWinlogonShell,
  registerStartup,
  suppressDesktopShellDeferred,
  unregisterStartup
} from './startup'
import {
  createAdminWindow,
  createLockWindow,
  createTrayPopover,
  isLockWindow
} from './windows'
import { bootLog } from './bootLog'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'

// The single source of truth for what mode the app is in and which windows
// exist. Everything that changes mode goes through here so windows, tray,
// keyboard hook, timers, and the broadcast state never drift apart.

interface ActiveSession {
  sessionId: string // local sessions-table row id
  serverSessionId: string | null // Supabase sessions.id (null for offline logins)
  account: AccountPublic
  mode: SessionMode
  timer: SessionTimer
  /**
   * Wall seconds from earlier mode segments on this visit. The live timer may
   * reset on Timed ↔ Open; totals are priorSecondsUsed + timer.elapsedSeconds.
   */
  priorSecondsUsed: number
  /** Purchased time left on the account (drains in 'timed' mode). */
  timeRemaining: number
  /** Money left on the account (drains in 'open' mode). */
  creditsCentavos: number
  /**
   * Sub-centavo open-time cost carried between ticks. Only whole centavos are
   * ever debited, so the remainder must survive until it completes a centavo.
   */
  centavoAccrual: number
  /** Whole centavos this visit has already debited (open mode), across segments. */
  spentCentavos: number
  remindersFired: Set<number>
  ended: boolean
}

/**
 * Open→timed handoff parks the visit on the lockscreen chooser without ending
 * the sessions row. resumeTimed continues the same sessionId.
 */
interface ParkedVisit {
  sessionId: string
  serverSessionId: string | null
  account: AccountPublic
  priorSecondsUsed: number
  spentCentavos: number
}

export class AppController {
  private mode: AppMode = 'lockscreen'
  private online = false
  private message: string | null = null
  private lockWindows: BrowserWindow[] = []
  private trayPopover: BrowserWindow | null = null
  private adminWindow: BrowserWindow | null = null
  private pc!: Pc
  private activeSession: ActiveSession | null = null
  /** Visit kept open across the open→timed chooser (not yet endSession'd). */
  private parkedVisit: ParkedVisit | null = null
  /** Account parked after open→timed switch, awaiting buy/resume on lockscreen. */
  private pendingAccount: AccountPublic | null = null
  /** Auto-clear timed chooser after 2 minutes if the user does not buy time. */
  private static readonly CHOOSER_TIMEOUT_MS = 120_000
  private chooserTimer: NodeJS.Timeout | null = null
  private chooserDeadlineAt: number | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private idleDeadline = 0
  private allowQuit = false
  private trayRef: import('electron').Tray | null = null
  /** Lazy tray factory from main — session HUD needs the tray icon. */
  private ensureTrayFn: (() => void) | null = null
  /** Last tray icon bounds from a click / menu show (for auto-positioning). */
  private lastTrayBounds: Electron.Rectangle | null = null
  /** Periodic shell-mode visibility reassert (cleared when leaving lockscreen). */
  private shellAssertTimer: ReturnType<typeof setInterval> | null = null
  /** True while createLockWindows is mid destroy→create (blocks nested rebuilds). */
  private lockCreateInProgress = false
  /** Coalesce rebuild requests that arrive during an in-flight create. */
  private lockCreatePending = false
  /** Debounce display-added/removed rebuilds during boot/DWM churn. */
  private displayChangeTimer: ReturnType<typeof setTimeout> | null = null

  init(): void {
    const cfg = getRuntimeConfig()
    this.pc = getOrCreatePc(getMachineIdCached(), cfg.pcName)
    screen.on('display-added', () => this.handleDisplayChange())
    screen.on('display-removed', () => this.handleDisplayChange())
    bootLog(`AppController.init pc=${this.pc.name} id=${this.pc.id}`)
    const disabledMsg = isAppFullyDisabled()
      ? 'Pixl is disabled on this PC. Sign in as admin to re-enable.'
      : null
    this.enterLockscreen(disabledMsg)
  }

  // ---- Accessors for IPC ----

  isAllowQuit(): boolean {
    return this.allowQuit
  }

  /**
   * Auto-install updates only on the lockscreen with no client visit in flight
   * (active session, parked open→timed, or pending resume).
   */
  isSafeToAutoInstallUpdate(): boolean {
    return (
      this.mode === 'lockscreen' &&
      !this.activeSession &&
      !this.parkedVisit &&
      !this.pendingAccount
    )
  }

  /** Pause watchdog and allow quit so electron-updater can replace the binary. */
  prepareForUpdateInstall(): void {
    enterMaintenanceMode()
    this.allowQuit = true
  }

  setTray(tray: import('electron').Tray): void {
    this.trayRef = tray
  }

  /** Wire main's lazy tray creator; called before session HUD needs the icon. */
  setEnsureTray(fn: () => void): void {
    this.ensureTrayFn = fn
  }

  setOnline(online: boolean): void {
    if (this.online !== online) {
      this.online = online
      this.broadcastState()
    }
  }

  getModeState(): ModeState {
    const settings = getSettings()
    return {
      mode: this.mode,
      online: this.online,
      account: this.activeSession?.account ?? this.pendingAccount ?? null,
      message: this.message,
      session: this.buildSnapshot(),
      pc: {
        machineId: this.pc.machine_id,
        name: this.pc.name,
        idleShutdownSeconds: settings.idleShutdownSeconds
      },
      pendingResume: this.pendingAccount
        ? { account: this.pendingAccount, fromMode: 'open' }
        : null,
      chooserDeadlineAt: this.chooserDeadlineAt,
      idleDeadlineAt: this.idleDeadline > 0 ? this.idleDeadline : null
    }
  }

  // ---- Mode transitions ----

  enterLockscreen(message: string | null): void {
    const alreadyLocked = this.mode === 'lockscreen'
    this.mode = 'lockscreen'
    this.message = message
    this.teardownSession()
    this.closeAdminWindow()
    this.hideTrayPopover()
    // Reuse healthy coverage when already locked — full destroy→create races
    // with display/shell events and can stack duplicate lock windows.
    if (alreadyLocked && this.lockWindowsHealthy()) {
      bootLog('enterLockscreen: reusing healthy lock windows')
      this.focusLockWindows()
    } else {
      // Create + show lock windows FIRST. Killing Explorer before the first paint
      // (previous v0.1.3 order) races DWM and yields a black screen that only
      // "recovers" when Admin Quit spawns explorer.exe again.
      this.createLockWindows()
    }
    suppressDesktopShellDeferred(2500)
    this.startShellVisibilityAssert()
    setKeyboardHookActive(true)
    setPcStatus(this.pc.id, 'locked', null)
    this.startIdleTimer()
    // Idle lockscreen: quietly check/download; install only when still safe.
    checkForUpdatesWhenIdle()
    maybeInstallPendingUpdate()
    this.broadcastState()
  }

  /** Re-show / focus lock windows (e.g. second-instance while locked). */
  focusLockWindows(): void {
    // Disable/quit destroys locks then app.quit(); a second launch while the
    // old process still holds the single-instance lock must NOT recreate them.
    if (this.allowQuit) {
      bootLog('focusLockWindows skipped (quitting)')
      return
    }
    if (this.mode !== 'lockscreen') return
    if (this.lockCreateInProgress) {
      this.lockCreatePending = true
      return
    }
    if (!this.lockWindowsHealthy()) {
      this.createLockWindows()
      return
    }
    for (const win of this.lockWindows) {
      if (win.isDestroyed()) continue
      win.setAlwaysOnTop(true, 'screen-saver')
      win.show()
      forceShellForeground(win)
    }
  }

  private startShellVisibilityAssert(): void {
    this.clearShellVisibilityAssert()
    if (!isPixlWinlogonShell()) return
    bootLog('starting shell visibility assert loop')
    this.shellAssertTimer = setInterval(() => {
      if (this.mode !== 'lockscreen') {
        this.clearShellVisibilityAssert()
        return
      }
      if (this.allowQuit || this.lockCreateInProgress) return
      if (!this.lockWindowsHealthy()) {
        bootLog('shell assert: lock windows missing/unhealthy — recreating')
        this.createLockWindows()
        return
      }
      for (const win of this.lockWindows) {
        if (win.isDestroyed()) continue
        try {
          if (!win.isVisible()) win.show()
          if (isPixlWinlogonShell()) {
            try {
              win.setKiosk(true)
              win.setFullScreen(true)
            } catch {
              /* ignore */
            }
          }
          win.setAlwaysOnTop(true, 'screen-saver')
          win.moveTop()
        } catch {
          /* ignore */
        }
      }
      const primary = this.lockWindows.find((w) => !w.isDestroyed())
      if (primary) forceShellForeground(primary)
    }, 8000)
  }

  private clearShellVisibilityAssert(): void {
    if (this.shellAssertTimer) {
      clearInterval(this.shellAssertTimer)
      this.shellAssertTimer = null
    }
  }

  startClientSession(
    account: AccountPublic,
    mode: SessionMode,
    serverSessionId: string | null
  ): void {
    // Continue the same visit after an open→timed chooser handoff.
    if (this.parkedVisit && this.parkedVisit.account.id === account.id) {
      this.continueParkedSession(account, mode, serverSessionId)
      return
    }
    if (this.parkedVisit) {
      this.finalizeParkedVisit('logout')
    }

    this.mode = 'session'
    this.message = null
    this.pendingAccount = null
    this.clearChooserTimer()
    this.clearIdleTimer()
    this.clearShellVisibilityAssert()
    setKeyboardHookActive(false)
    this.destroyLockWindows()
    // Cancel deferred lockscreen explorer kills, then restore taskbar/desktop.
    cancelSuppressDesktopShell()
    ensureDesktopShell()

    const session = createSession(account.id, this.pc.id, mode)
    setPcStatus(this.pc.id, 'in_session', account.id)

    const timer = new SessionTimer({
      onTick: (delta, total) => this.onSessionTick(delta, total)
    })
    this.activeSession = {
      sessionId: session.id,
      serverSessionId,
      account,
      mode,
      timer,
      priorSecondsUsed: 0,
      timeRemaining: account.time_balance_seconds,
      creditsCentavos: account.credits_centavos,
      centavoAccrual: 0,
      spentCentavos: 0,
      remindersFired: new Set(),
      ended: false
    }
    timer.start()
    this.ensureTrayFn?.()
    this.ensureTrayPopover()
    this.autoShowTrayPopover()
    this.broadcastState()
  }

  /** Resume a parked visit after the open→timed chooser (same sessions row). */
  private continueParkedSession(
    account: AccountPublic,
    mode: SessionMode,
    serverSessionId: string | null
  ): void {
    const park = this.parkedVisit
    if (!park) return
    this.parkedVisit = null

    this.mode = 'session'
    this.message = null
    this.pendingAccount = null
    this.clearChooserTimer()
    this.clearIdleTimer()
    this.clearShellVisibilityAssert()
    setKeyboardHookActive(false)
    this.destroyLockWindows()
    // Cancel deferred lockscreen explorer kills, then restore taskbar/desktop.
    cancelSuppressDesktopShell()
    ensureDesktopShell()

    updateSessionMode(park.sessionId, mode)
    setPcStatus(this.pc.id, 'in_session', account.id)

    const timer = new SessionTimer({
      onTick: (delta, total) => this.onSessionTick(delta, total)
    })
    this.activeSession = {
      sessionId: park.sessionId,
      serverSessionId: serverSessionId ?? park.serverSessionId,
      account,
      mode,
      timer,
      priorSecondsUsed: park.priorSecondsUsed,
      timeRemaining: account.time_balance_seconds,
      creditsCentavos: account.credits_centavos,
      centavoAccrual: 0,
      spentCentavos: park.spentCentavos,
      remindersFired: new Set(),
      ended: false
    }
    updateSessionUsage(park.sessionId, park.priorSecondsUsed, park.spentCentavos)
    timer.start()
    this.ensureTrayFn?.()
    this.ensureTrayPopover()
    this.autoShowTrayPopover()
    this.broadcastState()
  }

  /** Reconciler hook: current PC status + account for heartbeats. */
  getPcStatusForHeartbeat(): { status: 'locked' | 'in_session' | 'offline'; accountId: string | null } {
    if (this.mode === 'session' && this.activeSession) {
      return { status: 'in_session', accountId: this.activeSession.account.id }
    }
    return { status: 'locked', accountId: null }
  }

  /** Reconciler hook: server session id for an account's offline debits. */
  getServerSessionFor(accountId: string): string | null {
    if (this.activeSession && this.activeSession.account.id === accountId) {
      return this.activeSession.serverSessionId
    }
    return null
  }

  enterAdmin(account: AccountPublic): void {
    this.mode = 'admin'
    this.message = null
    this.clearIdleTimer()
    this.clearShellVisibilityAssert()
    setKeyboardHookActive(false)
    this.destroyLockWindows()
    // Admin needs desktop/taskbar the same as a client session.
    cancelSuppressDesktopShell()
    ensureDesktopShell()
    setPcStatus(this.pc.id, 'locked', account.id)
    if (!this.adminWindow || this.adminWindow.isDestroyed()) {
      this.adminWindow = createAdminWindow()
      this.adminWindow.on('closed', () => {
        this.adminWindow = null
        // Closing the admin window returns to lockscreen unless quitting.
        if (!this.allowQuit && this.mode === 'admin') this.enterLockscreen(null)
      })
    }
    // Stash the admin identity for admin operations.
    this.adminAccount = account
    this.broadcastState()
  }

  private adminAccount: AccountPublic | null = null

  getAdminAccount(): AccountPublic | null {
    return this.adminAccount
  }

  logout(reason: SessionEndedReason = 'logout'): void {
    // Closing the session row here (rather than in teardown) keeps the reason
    // accurate. Any leftover purchased time is refunded to credits.
    const s = this.activeSession
    if (s && !s.ended) {
      this.freezeTimerSegment(s)
    }
    this.refundActiveSessionTime()
    this.closeSessionRow(reason)
    this.finalizeParkedVisit(reason)
    this.activeSession = null
    this.adminAccount = null
    this.pendingAccount = null
    this.clearChooserTimer()
    this.enterLockscreen(logoutMessage(reason))
  }

  // ---- Mode switching ----

  private static readonly CHOOSE_TIME_MESSAGE = 'Choose time to continue'

  /**
   * Mid-session Timed ↔ Open. Keeps the same sessions row for the whole visit;
   * only the live timer segment resets. timed→open refunds time and continues
   * open (or ends if no credits). open→timed parks on lockscreen with pendingResume.
   */
  switchMode(mode: SessionMode): SwitchModeResult {
    const s = this.activeSession
    if (!s || this.mode !== 'session' || s.ended) {
      return { outcome: 'error', message: 'No active session.', account: null }
    }
    if (s.mode === mode) {
      return { outcome: 'ok', message: '', account: s.account }
    }

    if (s.mode === 'timed' && mode === 'open') {
      this.freezeTimerSegment(s)
      const refunded = refundTimeToCredits(s.account.id)
      const account = refunded.account

      if (account && account.credits_centavos > 0) {
        this.remorphSessionMode(s, account, 'open')
        return { outcome: 'ok', message: '', account }
      }

      // Cannot continue in open — true visit end.
      this.closeSessionRow('credits_exhausted')
      this.activeSession = null
      this.pendingAccount = null
      this.enterLockscreen(NO_CREDITS_MESSAGE)
      return {
        outcome: 'no_credits',
        message: NO_CREDITS_MESSAGE,
        account
      }
    }

    if (s.mode === 'open' && mode === 'timed') {
      // Stop open-time drain; keep the sessions row open across the chooser.
      this.freezeTimerSegment(s)
      updateSessionUsage(s.sessionId, s.priorSecondsUsed, s.spentCentavos)
      updateSessionMode(s.sessionId, 'timed')
      const fresh = getAccountById(s.account.id)
      const account = fresh
        ? toPublic(fresh)
        : {
            ...s.account,
            credits_centavos: s.creditsCentavos,
            time_balance_seconds: s.timeRemaining
          }
      this.parkedVisit = {
        sessionId: s.sessionId,
        serverSessionId: s.serverSessionId,
        account,
        priorSecondsUsed: s.priorSecondsUsed,
        spentCentavos: s.spentCentavos
      }
      this.activeSession = null
      this.beginTimedChooser(account)
      if (account.credits_centavos <= 0) {
        return {
          outcome: 'no_credits',
          message: NO_CREDITS_MESSAGE,
          account
        }
      }
      return {
        outcome: 'needs_time',
        message: AppController.CHOOSE_TIME_MESSAGE,
        account
      }
    }

    return { outcome: 'error', message: 'Unsupported mode switch.', account: s.account }
  }

  /**
   * Same visit, new mode segment: update DB mode, reset the timer, keep totals.
   */
  private remorphSessionMode(
    s: ActiveSession,
    account: AccountPublic,
    mode: SessionMode
  ): void {
    updateSessionMode(s.sessionId, mode)
    updateSessionUsage(s.sessionId, s.priorSecondsUsed, s.spentCentavos)
    s.account = account
    s.mode = mode
    s.timeRemaining = account.time_balance_seconds
    s.creditsCentavos = account.credits_centavos
    s.centavoAccrual = 0
    s.remindersFired.clear()
    s.timer = new SessionTimer({
      onTick: (delta, total) => this.onSessionTick(delta, total)
    })
    s.timer.start()
    this.pushSnapshot()
    this.broadcastState()
  }

  /**
   * Continues a pending open→timed handoff. Optionally buys time first; starts
   * a timed session when the account has purchased seconds.
   */
  resumeTimed(purchaseCentavos = 0): LoginResult {
    const pending = this.pendingAccount
    if (!pending) {
      return {
        outcome: 'error',
        message: 'No pending session to resume.',
        account: null
      }
    }

    const fresh = getAccountById(pending.id)
    let account: AccountPublic = fresh ? toPublic(fresh) : pending

    if (purchaseCentavos > 0) {
      const bought = purchaseTime(account.id, purchaseCentavos)
      if (bought.outcome !== 'ok' || !bought.account) {
        const next = bought.account ?? account
        // Keep the original deadline while the user retries; 0 credits ends handoff.
        this.beginTimedChooser(next, AppController.CHOOSE_TIME_MESSAGE, false)
        return {
          outcome: next.credits_centavos <= 0 ? 'no_credits' : 'error',
          message: next.credits_centavos <= 0 ? NO_CREDITS_MESSAGE : bought.message,
          account: next
        }
      }
      account = bought.account
    }

    if (account.time_balance_seconds > 0) {
      this.pendingAccount = null
      this.clearChooserTimer()
      this.startClientSession(account, 'timed', null)
      return { outcome: 'ok', message: '', account }
    }

    // Still no time: keep chooser without restarting the 120s clock.
    this.beginTimedChooser(account, AppController.CHOOSE_TIME_MESSAGE, false)
    if (account.credits_centavos <= 0) {
      return {
        outcome: 'no_credits',
        message: NO_CREDITS_MESSAGE,
        account
      }
    }
    return {
      outcome: 'needs_time',
      message: AppController.CHOOSE_TIME_MESSAGE,
      account
    }
  }

  /**
   * Park an account on the lockscreen timed chooser. Zero credits → immediate
   * clear with NO_CREDITS_MESSAGE (and end any parked visit). Otherwise starts
   * (or keeps) a 2-minute timer.
   */
  beginTimedChooser(
    account: AccountPublic,
    message: string = AppController.CHOOSE_TIME_MESSAGE,
    /** When false, keep an existing chooserDeadlineAt (e.g. resume retry). */
    restartTimer = true
  ): void {
    if (account.credits_centavos <= 0) {
      this.clearChooserTimer()
      this.pendingAccount = null
      this.finalizeParkedVisit('credits_exhausted')
      if (this.mode !== 'lockscreen') {
        this.enterLockscreen(NO_CREDITS_MESSAGE)
      } else {
        this.message = NO_CREDITS_MESSAGE
        this.broadcastState()
      }
      return
    }

    this.pendingAccount = account
    if (this.mode !== 'lockscreen') {
      this.enterLockscreen(message)
    } else {
      this.message = message
    }
    // Don't idle-shutdown while the player is picking time on the chooser.
    this.clearIdleTimer()
    if (restartTimer || this.chooserDeadlineAt == null) {
      this.startChooserTimer()
    }
    this.broadcastState()
  }

  /** Clears pendingResume, ends a parked visit, and stays on the lockscreen. */
  cancelPendingResume(): void {
    this.clearChooserTimer()
    this.pendingAccount = null
    this.finalizeParkedVisit('logout')
    this.message = null
    // Back to an empty lockscreen — resume idle auto-shutdown.
    this.startIdleTimer()
    this.broadcastState()
  }

  private startChooserTimer(): void {
    this.clearChooserTimer()
    this.chooserDeadlineAt = Date.now() + AppController.CHOOSER_TIMEOUT_MS
    this.chooserTimer = setTimeout(() => {
      this.chooserTimer = null
      this.chooserDeadlineAt = null
      this.pendingAccount = null
      this.finalizeParkedVisit('logout')
      this.message = 'Timed out — sign in again to continue'
      this.startIdleTimer()
      this.broadcastState()
    }, AppController.CHOOSER_TIMEOUT_MS)
  }

  private clearChooserTimer(): void {
    if (this.chooserTimer) clearTimeout(this.chooserTimer)
    this.chooserTimer = null
    this.chooserDeadlineAt = null
  }

  // ---- Buying time ----

  /**
   * Converts money into purchased time. Works mid-session (the live countdown
   * picks up the extra seconds immediately) and from the lockscreen/admin flow
   * when an explicit account id is supplied.
   */
  buyTime(input: BuyTimeInput): BuyTimeResult {
    const s = this.activeSession
    const accountId = input.accountId ?? s?.account.id ?? null
    if (!accountId) {
      return {
        outcome: 'no_account',
        message: 'No account to buy time for.',
        account: null,
        addedSeconds: 0,
        session: null
      }
    }

    const res = purchaseTime(accountId, input.centavos)
    if (res.outcome === 'ok' && res.account) {
      this.applyAccountBalances(res.account)
    }
    return {
      outcome: res.outcome,
      message: res.message,
      account: res.account,
      addedSeconds: res.addedSeconds,
      session: this.buildSnapshot()
    }
  }

  /** Re-seeds live session state after an out-of-band balance change. */
  private applyAccountBalances(account: AccountPublic): void {
    const s = this.activeSession
    if (!s || s.account.id !== account.id) {
      this.broadcastState()
      return
    }
    s.account = account
    s.timeRemaining = account.time_balance_seconds
    s.creditsCentavos = account.credits_centavos
    // A top-up re-arms the low-balance warnings for the new runway.
    s.remindersFired.clear()
    this.pushSnapshot()
    this.broadcastState()
  }

  // ---- Session ticking ----

  private onSessionTick(deltaSeconds: number, segmentTotalSeconds: number): void {
    const s = this.activeSession
    if (!s || s.ended) return
    // Timer segment totals reset on mode switch; visit totals include priors.
    const visitSeconds = s.priorSecondsUsed + segmentTotalSeconds

    if (s.mode === 'timed') {
      this.tickTimed(s, deltaSeconds, visitSeconds)
    } else {
      this.tickOpen(s, deltaSeconds, visitSeconds)
    }
  }

  /** Timed mode: purchased seconds drain 1:1; money is untouched. */
  private tickTimed(s: ActiveSession, deltaSeconds: number, visitSeconds: number): void {
    const remaining = adjustTimeBalance(s.account.id, -deltaSeconds)
    s.timeRemaining = remaining
    updateSessionUsage(s.sessionId, visitSeconds, s.spentCentavos)

    const createdAt = new Date().toISOString()
    const seq = nextSeq()
    insertLedger({
      id: randomUUID(),
      account_id: s.account.id,
      admin_id: null,
      kind: 'session',
      delta_centavos: 0,
      delta_seconds: -deltaSeconds,
      note: 'timed session',
      created_at: createdAt,
      synced_from: 'offline_queue',
      seq
    })
    enqueue('session_time', {
      account_id: s.account.id,
      session_id: s.serverSessionId,
      pc_id: this.pc.id,
      delta_seconds: -deltaSeconds,
      created_at: createdAt
    })

    this.maybeFireReminders(s, remaining)
    this.pushSnapshot()

    if (remaining <= 0) {
      this.logout('time_exhausted')
    }
  }

  /**
   * Open time: money drains continuously. The per-second cost is fractional, so
   * it is accumulated in memory and only whole centavos are ever written.
   */
  private tickOpen(s: ActiveSession, deltaSeconds: number, visitSeconds: number): void {
    const rate = getSettings().pesoToSecondsRate
    s.centavoAccrual += deltaSeconds * centavosPerSecond(rate)

    const due = Math.floor(s.centavoAccrual)
    if (due > 0) {
      s.centavoAccrual -= due
      s.creditsCentavos = adjustCredits(s.account.id, -due)
      s.spentCentavos += due

      const createdAt = new Date().toISOString()
      const seq = nextSeq()
      insertLedger({
        id: randomUUID(),
        account_id: s.account.id,
        admin_id: null,
        kind: 'open_time',
        delta_centavos: -due,
        delta_seconds: 0,
        note: 'open time',
        created_at: createdAt,
        synced_from: 'offline_queue',
        seq
      })
      enqueue('session_credits', {
        account_id: s.account.id,
        session_id: s.serverSessionId,
        pc_id: this.pc.id,
        delta_centavos: -due,
        elapsed_seconds: visitSeconds,
        created_at: createdAt
      })
    }
    updateSessionUsage(s.sessionId, visitSeconds, s.spentCentavos)

    // Warn on the money runway expressed in seconds, so the same reminder
    // thresholds mean the same thing in both modes.
    this.maybeFireReminders(s, centavosToSeconds(Math.max(0, s.creditsCentavos), rate))
    this.pushSnapshot()

    if (s.creditsCentavos <= 0) {
      this.logout('credits_exhausted')
    }
  }

  private maybeFireReminders(s: ActiveSession, remainingSeconds: number): void {
    const thresholds = getSettings().reminderThresholdsSeconds
    for (const t of thresholds) {
      if (remainingSeconds <= t && !s.remindersFired.has(t)) {
        s.remindersFired.add(t)
        this.showReminder(t, s.mode)
      }
    }
  }

  private showReminder(secondsLeft: number, mode: SessionMode): void {
    if (!Notification.isSupported()) return
    const mins = Math.round(secondsLeft / 60)
    const left =
      secondsLeft >= 60
        ? `about ${mins} minute${mins === 1 ? '' : 's'}`
        : 'less than a minute'
    const body =
      mode === 'timed'
        ? `You have ${left} of time left. Buy more time to keep playing.`
        : `Your credits will run out in ${left}. Top up at the counter.`
    const title = mode === 'timed' ? 'Pixl — Time running low' : 'Pixl — Credits running low'
    // silent + no focus steal; auto-dismisses.
    const n = new Notification({ title, body, silent: false })
    n.show()
  }

  // ---- Snapshots ----

  private buildSnapshot(): SessionSnapshot | null {
    const s = this.activeSession
    if (!s) return null
    const rate = getSettings().pesoToSecondsRate
    const credits = Math.max(0, s.creditsCentavos)
    return {
      accountId: s.account.id,
      displayName: s.account.display_name || s.account.username,
      username: s.account.username,
      mode: s.mode,
      secondsUsedThisSession: this.visitSecondsUsed(s),
      creditsCentavos: credits,
      timeBalanceSeconds: Math.max(0, s.timeRemaining),
      spentCentavos: s.spentCentavos,
      secondsRemaining:
        s.mode === 'timed' ? Math.max(0, s.timeRemaining) : centavosToSeconds(credits, rate)
    }
  }

  private pushSnapshot(): void {
    const snap = this.buildSnapshot()
    if (!snap) return
    if (this.trayPopover && !this.trayPopover.isDestroyed()) {
      this.trayPopover.webContents.send(IPC.onSessionTick, snap)
    }
    this.updateTrayTooltip(snap)
  }

  private updateTrayTooltip(snap: SessionSnapshot): void {
    if (!this.trayRef) return
    const left = formatDuration(snap.secondsRemaining)
    this.trayRef.setToolTip(
      `Pixl — ${snap.displayName} — ${formatPesos(snap.creditsCentavos)} · ${left} left`
    )
  }

  // ---- Lock windows / displays ----

  /** Alive lock windows matching the current display count (no gaps/orphans). */
  private lockWindowsHealthy(): boolean {
    if (this.lockCreateInProgress) return false
    const displays = screen.getAllDisplays().length
    if (displays === 0 || this.lockWindows.length !== displays) return false
    return this.lockWindows.every((w) => !w.isDestroyed())
  }

  private createLockWindows(): void {
    if (this.allowQuit) {
      bootLog('createLockWindows skipped (quitting)')
      return
    }
    // Nested creates (display events / shell assert mid-construction) used to
    // clear the tracking array then push a second set → stacked lockscreens.
    if (this.lockCreateInProgress) {
      this.lockCreatePending = true
      bootLog('createLockWindows coalesced (already in progress)')
      return
    }
    this.lockCreateInProgress = true
    this.lockCreatePending = false
    try {
      this.destroyLockWindows()
      const displays = screen.getAllDisplays()
      const primaryId = screen.getPrimaryDisplay().id
      bootLog(
        `createLockWindows count=${displays.length} primary=${primaryId} shell=${isPixlWinlogonShell()}`
      )
      for (const d of displays) {
        const role = d.id === primaryId ? 'primary' : 'secondary'
        const win = createLockWindow(d, role)
        this.hardenLockWindow(win)
        this.lockWindows.push(win)
      }
      const primaryWin = this.lockWindows[0]
      if (primaryWin) forceShellForeground(primaryWin)
    } finally {
      this.lockCreateInProgress = false
      if (this.lockCreatePending && this.mode === 'lockscreen' && !this.allowQuit) {
        this.lockCreatePending = false
        bootLog('createLockWindows running coalesced rebuild')
        this.createLockWindows()
      } else {
        this.lockCreatePending = false
      }
    }
  }

  private hardenLockWindow(win: BrowserWindow): void {
    // Block close / Alt+F4 while locked (unless admin flagged quit).
    win.on('close', (e) => {
      if (!this.allowQuit) e.preventDefault()
    })
    // Re-assert always-on-top if focus is lost.
    win.on('blur', () => {
      if (this.allowQuit) return
      if (this.mode === 'lockscreen' && !win.isDestroyed()) {
        win.setAlwaysOnTop(true, 'screen-saver')
        // Avoid focus thrash loops; steal only in shell mode.
        if (isPixlWinlogonShell()) forceShellForeground(win)
        else win.focus()
      }
    })
  }

  private destroyLockWindows(): void {
    const seen = new Set<BrowserWindow>()
    for (const w of this.lockWindows) {
      seen.add(w)
      if (!w.isDestroyed()) {
        w.removeAllListeners('close')
        w.destroy()
      }
    }
    // Sweep orphans from reentrant creates that escaped the tracking array.
    for (const w of BrowserWindow.getAllWindows()) {
      if (seen.has(w) || w.isDestroyed() || !isLockWindow(w)) continue
      bootLog('destroyLockWindows: sweeping orphan lock window')
      w.removeAllListeners('close')
      w.destroy()
    }
    this.lockWindows = []
  }

  private handleDisplayChange(): void {
    if (this.allowQuit || this.mode !== 'lockscreen') return
    // Debounce: cold boot / kiosk fullscreen often fires rapid display events.
    if (this.displayChangeTimer) clearTimeout(this.displayChangeTimer)
    this.displayChangeTimer = setTimeout(() => {
      this.displayChangeTimer = null
      if (this.allowQuit || this.mode !== 'lockscreen') return
      bootLog('display change — rebuilding lock windows')
      this.createLockWindows()
    }, 200)
  }

  // ---- Tray popover ----

  private ensureTrayPopover(): void {
    if (!this.trayPopover || this.trayPopover.isDestroyed()) {
      this.trayPopover = createTrayPopover()
    }
  }

  toggleTrayPopover(bounds?: Electron.Rectangle): void {
    if (bounds) this.lastTrayBounds = bounds
    this.ensureTrayPopover()
    const win = this.trayPopover!
    if (win.isVisible()) {
      win.hide()
      return
    }
    this.positionTrayPopover(bounds ?? this.lastTrayBounds)
    win.show()
    win.focus()
    const snap = this.buildSnapshot()
    if (snap) win.webContents.send(IPC.onSessionTick, snap)
  }

  /** Show the tray after a session starts (uses last click bounds or work-area BR). */
  private autoShowTrayPopover(): void {
    this.ensureTrayPopover()
    const win = this.trayPopover!
    if (win.isVisible()) {
      const snap = this.buildSnapshot()
      if (snap) win.webContents.send(IPC.onSessionTick, snap)
      return
    }
    const bounds = this.lastTrayBounds ?? this.bottomRightTrayAnchor()
    this.positionTrayPopover(bounds)
    win.show()
    win.focus()
    const snap = this.buildSnapshot()
    if (snap) win.webContents.send(IPC.onSessionTick, snap)
  }

  private bottomRightTrayAnchor(): Electron.Rectangle {
    const wa = screen.getPrimaryDisplay().workArea
    return {
      x: wa.x + wa.width - 32,
      y: wa.y + wa.height,
      width: 24,
      height: 0
    }
  }

  private positionTrayPopover(bounds: Electron.Rectangle | null): void {
    const win = this.trayPopover
    if (!win || win.isDestroyed() || !bounds) return
    const { width, height } = win.getBounds()
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    let x = Math.round(bounds.x + bounds.width / 2 - width / 2)
    let y = Math.round(bounds.y - height)
    // Keep it on-screen (taskbar usually at bottom).
    if (y + height > display.workArea.y + display.workArea.height) {
      y = bounds.y - height
    }
    if (y < display.workArea.y) y = bounds.y + bounds.height
    x = Math.max(
      display.workArea.x,
      Math.min(x, display.workArea.x + display.workArea.width - width)
    )
    win.setPosition(x, y, false)
  }

  private hideTrayPopover(): void {
    if (this.trayPopover && !this.trayPopover.isDestroyed()) this.trayPopover.hide()
  }

  private closeAdminWindow(): void {
    if (this.adminWindow && !this.adminWindow.isDestroyed()) {
      this.adminWindow.removeAllListeners('closed')
      this.adminWindow.destroy()
    }
    this.adminWindow = null
  }

  /** Refunds leftover purchased time on the active session; no-op otherwise. */
  private refundActiveSessionTime(): void {
    const s = this.activeSession
    if (!s || s.ended) return
    const refunded = refundTimeToCredits(s.account.id)
    if (refunded.account) {
      s.account = refunded.account
      s.timeRemaining = refunded.account.time_balance_seconds
      s.creditsCentavos = refunded.account.credits_centavos
    }
  }

  /** Wall seconds for the whole login→logout visit (priors + current segment). */
  private visitSecondsUsed(s: ActiveSession): number {
    return s.priorSecondsUsed + s.timer.elapsedSeconds
  }

  /**
   * Fold the live timer segment into priorSecondsUsed and stop the timer.
   * Must run before SessionTimer.stop() is relied on for totals — stop() zeros
   * elapsedSeconds.
   */
  private freezeTimerSegment(s: ActiveSession): void {
    const segment = s.timer.elapsedSeconds
    s.timer.stop()
    s.priorSecondsUsed += segment
  }

  /**
   * End a visit parked on the open→timed chooser. Does not touch an active
   * session. Leftover purchased time (if any) is refunded to credits.
   */
  private finalizeParkedVisit(reason: SessionEndedReason): void {
    const park = this.parkedVisit
    if (!park) return
    this.parkedVisit = null
    refundTimeToCredits(park.account.id)
    endSession(park.sessionId, park.priorSecondsUsed, park.spentCentavos, reason)
  }

  /** Marks the session row finished; safe to call more than once. */
  private closeSessionRow(reason: SessionEndedReason): void {
    const s = this.activeSession
    if (!s || s.ended) return
    s.ended = true
    endSession(s.sessionId, this.visitSecondsUsed(s), s.spentCentavos, reason)
  }

  /**
   * Ends the active session only. Parked open→timed visits stay open so the
   * chooser can resume the same sessions row — use finalizeParkedVisit to end those.
   */
  private teardownSession(): void {
    if (this.activeSession) {
      const s = this.activeSession
      if (!s.ended) {
        this.freezeTimerSegment(s)
        this.refundActiveSessionTime()
        this.closeSessionRow('logout')
      }
      this.activeSession = null
    }
  }

  // ---- Idle auto-shutdown ----

  private startIdleTimer(): void {
    this.clearIdleTimer()
    const { idleShutdownSeconds } = getSettings()
    if (idleShutdownSeconds <= 0) return // disabled (e.g. admin machine)
    this.idleDeadline = Date.now() + idleShutdownSeconds * 1000
    this.idleTimer = setInterval(() => {
      if (Date.now() >= this.idleDeadline) {
        this.clearIdleTimer()
        endSessionShutdownLog()
        // Clear deadline in UI even if OS shutdown is suppressed (dev/guard).
        this.broadcastState()
        shutdownWindows('idle timeout on lockscreen')
      }
    }, 1000)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.idleDeadline = 0
  }

  // ---- Admin quit path ----

  requestAdminQuit(): void {
    bootLog('requestAdminQuit — maintenance + explorer spawn (this is why Quit "fixes" black screen)')
    this.clearShellVisibilityAssert()
    // Stop any lockscreen deferred kills before we hand the desktop back.
    cancelSuppressDesktopShell()
    enterMaintenanceMode()
    // When Pixl is the Winlogon shell, quitting leaves no desktop — start
    // Explorer so staff can maintain the machine in this session.
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        const child = spawn('explorer.exe', [], { detached: true, stdio: 'ignore' })
        child.unref()
      } catch (err) {
        console.warn('[quit] failed to start explorer.exe:', err)
      }
    }
    this.allowQuit = true
    this.destroyLockWindows()
    this.closeAdminWindow()
    this.teardownSession()
    this.finalizeParkedVisit('admin')
    app.quit()
  }

  /**
   * Persistent master disable: remove autostart, pause watchdog for this
   * session, restore Explorer, and quit. Survives reboots via disabled.flag.
   * Aborts (throws) if the flag cannot be written — no unregister/quit.
   */
  requestAdminDisable(): void {
    bootLog('requestAdminDisable — persistent disable + unregister startup + quit')
    setAppFullyDisabled(true)
    if (!isAppFullyDisabled()) {
      throw new Error('disabled.flag missing after write; aborting disable')
    }
    this.clearShellVisibilityAssert()
    // Stop any lockscreen deferred kills before we hand the desktop back.
    // Do not use ensureDesktopShell() after unregisterStartup — Shell no longer
    // points at Pixl, so that helper would no-op.
    cancelSuppressDesktopShell()
    unregisterStartup()
    // Also write boot-scoped maintenance so this session stays quiet even if
    // the service is still running briefly before it notices disabled.flag.
    enterMaintenanceMode()
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        const child = spawn('explorer.exe', [], { detached: true, stdio: 'ignore' })
        child.unref()
      } catch (err) {
        console.warn('[disable] failed to start explorer.exe:', err)
      }
    }
    this.allowQuit = true
    this.destroyLockWindows()
    this.closeAdminWindow()
    this.teardownSession()
    this.finalizeParkedVisit('admin')
    app.quit()
  }

  /**
   * Clear master disable and restore kiosk autostart + watchdog. Stays in the
   * current admin UI; next lockscreen entry runs full kiosk again.
   * Aborts (throws) if the flag cannot be cleared.
   */
  enableAppAndResumeKiosk(): void {
    bootLog('enableAppAndResumeKiosk — clear disabled.flag + register startup + watchdog')
    setAppFullyDisabled(false)
    if (isAppFullyDisabled()) {
      throw new Error('disabled.flag still present after clear; aborting enable')
    }
    registerStartup()
    ensureWatchdogProtection()
    // Disabled boot skips initKeyboardHook; restore it for the next lockscreen.
    initKeyboardHook()
    this.broadcastState()
  }

  // ---- Broadcast ----

  broadcastState(): void {
    const state = this.getModeState()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.onModeState, state)
    }
  }
}

function logoutMessage(reason: SessionEndedReason): string | null {
  switch (reason) {
    case 'time_exhausted':
      return 'Time used up — buy more time to keep playing'
    case 'credits_exhausted':
      return NO_CREDITS_MESSAGE
    default:
      return null
  }
}

function endSessionShutdownLog(): void {
  console.log('[idle] shutting down after idle timeout')
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${sec}s`
}
