import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'

// GitHub Releases feed (owner/repo from package.json build.publish). Version
// comes from package.json via app.getVersion(); ship by bumping that, tagging
// vX.Y.Z, packaging, and publishing the Release assets.

const AUTO_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1000

export type UpdateInstallHooks = {
  /** True when lockscreen with no paid/parked client session. */
  isSafeToAutoInstall: () => boolean
  /** Pause watchdog + allow process quit before quitAndInstall. */
  prepareForInstall: () => void
}

let hooks: UpdateInstallHooks | null = null
let lastAutoCheckAt = 0
let installWhenReady = false
let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  downloadPercent: null,
  message: null
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.onUpdateStatus, status)
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  broadcast()
}

function isUnpackaged(): boolean {
  return !app.isPackaged
}

function tryAutoInstall(): void {
  if (!installWhenReady) return
  if (!hooks?.isSafeToAutoInstall()) {
    console.log('[updater] update downloaded; waiting for safe idle lockscreen')
    return
  }
  console.log('[updater] installing update on idle lockscreen')
  installUpdateNow()
}

/**
 * Wire electron-updater once after app ready. No-ops in unpackaged/dev builds.
 */
export function initUpdater(nextHooks: UpdateInstallHooks): void {
  hooks = nextHooks
  status = {
    ...status,
    currentVersion: app.getVersion(),
    phase: isUnpackaged() ? 'disabled' : 'idle',
    message: isUnpackaged() ? 'Updates run only in the packaged app' : null
  }

  if (isUnpackaged()) {
    console.log('[updater] skipped (unpackaged / dev)')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Cafe PCs: quiet background checks; do not show electron-updater dialogs.
  autoUpdater.forceDevUpdateConfig = false

  autoUpdater.on('checking-for-update', () => {
    setStatus({
      phase: 'checking',
      message: 'Checking for updates…',
      downloadPercent: null
    })
  })

  autoUpdater.on('update-available', (info) => {
    setStatus({
      phase: 'available',
      availableVersion: info.version,
      message: `Update ${info.version} available — downloading…`,
      downloadPercent: 0
    })
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({
      phase: 'not-available',
      availableVersion: null,
      message: 'Up to date',
      downloadPercent: null
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    setStatus({
      phase: 'downloading',
      downloadPercent: pct,
      message: `Downloading… ${pct}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      phase: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
      message: `Update ${info.version} ready to install`
    })
    tryAutoInstall()
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err)
    setStatus({
      phase: 'error',
      message: err?.message || 'Update check failed',
      downloadPercent: null
    })
  })

  console.log(`[updater] ready (version ${app.getVersion()}, feed GitHub Chibiby/pixl-app)`)
}

export function getUpdateStatus(): UpdateStatus {
  return {
    ...status,
    currentVersion: app.isReady() ? app.getVersion() : status.currentVersion
  }
}

/**
 * Manual or idle check. When `autoInstall` is true, quit-and-install after
 * download if still on a safe lockscreen (no client session).
 */
export async function checkForUpdates(opts?: {
  autoInstall?: boolean
}): Promise<UpdateStatus> {
  if (isUnpackaged()) {
    console.log('[updater] check skipped (unpackaged / dev)')
    return getUpdateStatus()
  }

  installWhenReady = opts?.autoInstall === true

  // Avoid overlapping checks while already busy.
  if (status.phase === 'checking' || status.phase === 'downloading') {
    return getUpdateStatus()
  }

  // Already downloaded — optionally install now for idle path.
  if (status.phase === 'downloaded') {
    if (installWhenReady) tryAutoInstall()
    return getUpdateStatus()
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[updater] checkForUpdates failed:', message)
    setStatus({ phase: 'error', message })
  }
  return getUpdateStatus()
}

/**
 * Background check from the lockscreen idle path. Throttled so we do not hit
 * GitHub on every brief return to the lockscreen.
 */
export function checkForUpdatesWhenIdle(): void {
  if (isUnpackaged()) return
  const now = Date.now()
  if (now - lastAutoCheckAt < AUTO_CHECK_MIN_INTERVAL_MS) return
  lastAutoCheckAt = now
  void checkForUpdates({ autoInstall: true })
}

/** Apply a downloaded update (admin "Update now", or idle auto-install). */
export function installUpdateNow(): UpdateStatus {
  if (isUnpackaged()) {
    console.log('[updater] install skipped (unpackaged / dev)')
    return getUpdateStatus()
  }

  if (status.phase !== 'downloaded' && status.phase !== 'available') {
    // If somehow available but not finished, kick a check+download first.
    void checkForUpdates({ autoInstall: true })
    return getUpdateStatus()
  }

  try {
    hooks?.prepareForInstall()
    // isSilent=false still avoids dialogs when configured; force run after.
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[updater] quitAndInstall failed:', message)
    setStatus({ phase: 'error', message })
  }
  return getUpdateStatus()
}

/** After returning to a safe lockscreen, install a pending download. */
export function maybeInstallPendingUpdate(): void {
  if (status.phase === 'downloaded') tryAutoInstall()
}
