import { app, BrowserWindow } from 'electron'
import { execFileSync, spawn } from 'child_process'
import { bootLog } from './bootLog'
import { isAppFullyDisabled } from './disable'

/** Pending deferred explorer kills from suppressDesktopShellDeferred. */
let suppressDesktopShellTimers: ReturnType<typeof setTimeout>[] = []
/**
 * Bumped by cancelSuppressDesktopShell so a deferred callback that already
 * left the event queue cannot still taskkill Explorer after a session/admin
 * restore. Paired with sync taskkill below.
 */
let suppressDesktopShellEpoch = 0

const WINLOGON_KEY =
  'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'

/**
 * True when HKCU Winlogon Shell points at this packaged Pixl binary
 * (i.e. Pixl is the kiosk shell instead of Explorer).
 */
export function isPixlWinlogonShell(): boolean {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  try {
    const out = execFileSync(
      'reg',
      ['query', WINLOGON_KEY, '/v', 'Shell'],
      { windowsHide: true, encoding: 'utf8' }
    )
    const match = /Shell\s+REG_SZ\s+(.+)/i.exec(out)
    if (!match) return false
    const shell = match[1].trim().replace(/^"|"$/g, '')
    return shell.toLowerCase() === process.execPath.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Best-effort kill of Explorer/taskbar when Pixl is the Winlogon shell.
 * Leftover Explorer (e.g. after maintenance) steals focus and leaves a
 * taskbar over the lockscreen. Never runs unpackaged/dev.
 *
 * Call AFTER lock windows are created and shown — killing Explorer before
 * the first paint can leave a black compositor with no shell and no visible
 * Electron window (Admin→Quit "fixes" this only by spawning explorer.exe).
 */
export function suppressDesktopShell(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  if (!isPixlWinlogonShell()) return
  bootLog('suppressDesktopShell: taskkill explorer.exe')
  // Sync on purpose: async taskkill can finish after cancel+ensureDesktopShell
  // and re-kill the Explorer we just restored (no taskbar in session).
  try {
    execFileSync('taskkill', ['/F', '/IM', 'explorer.exe'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    bootLog('suppressDesktopShell: explorer killed')
  } catch {
    bootLog('suppressDesktopShell: taskkill done (explorer may be absent)')
  }
}

/**
 * Cancel pending deferred explorer kills. Call before starting a client
 * session or admin so a late timer cannot kill Explorer after restore.
 */
export function cancelSuppressDesktopShell(): void {
  suppressDesktopShellEpoch += 1
  for (const t of suppressDesktopShellTimers) clearTimeout(t)
  suppressDesktopShellTimers = []
}

/**
 * Defer explorer kill so the first lock paint is not racing DWM teardown.
 * Cancels any prior deferred kills first (safe on re-enter lockscreen).
 */
export function suppressDesktopShellDeferred(delayMs = 2500): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  if (!isPixlWinlogonShell()) return
  cancelSuppressDesktopShell()
  const epoch = suppressDesktopShellEpoch
  const run = (): void => {
    if (epoch !== suppressDesktopShellEpoch) return
    suppressDesktopShell()
  }
  suppressDesktopShellTimers.push(setTimeout(run, delayMs))
  // Windows sometimes auto-restarts explorer; sweep again shortly after.
  suppressDesktopShellTimers.push(setTimeout(run, delayMs + 4000))
}

/**
 * Restore Explorer/taskbar after lockscreen suppress. Winlogon-shell kiosks
 * kill explorer.exe on lock; session/admin need it back for Alt+Tab, desktop,
 * and the taskbar. Best-effort spawn (detached/unref) matching Admin Quit —
 * Windows typically ignores a duplicate shell if Explorer is already running.
 * Never runs unpackaged/dev; only when Pixl is the Winlogon shell.
 */
export function ensureDesktopShell(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  if (!isPixlWinlogonShell()) return
  bootLog('ensureDesktopShell: spawn explorer.exe')
  try {
    const child = spawn('explorer.exe', [], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (err) {
    console.warn('[startup] failed to start explorer.exe:', err)
    bootLog(`ensureDesktopShell FAILED: ${String(err)}`)
  }
}

/**
 * Force the Electron process / window into the foreground. Winlogon-shell
 * cold start often leaves our HWND created but not activated (black screen
 * until a later focus change). Admin quit "works" only because it starts
 * Explorer — this path must recover without Explorer.
 */
export function forceShellForeground(win?: BrowserWindow | null): void {
  if (process.platform !== 'win32') return
  try {
    app.focus({ steal: true })
  } catch {
    try {
      app.focus()
    } catch {
      /* older electron */
    }
  }
  if (!win || win.isDestroyed()) return
  try {
    if (!win.isVisible()) win.show()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    win.focus()
    win.flashFrame(true)
    setTimeout(() => {
      if (!win.isDestroyed()) win.flashFrame(false)
    }, 400)
  } catch {
    /* ignore */
  }
}

// Register the app to auto-launch at Windows login. Prefer Winlogon Shell so
// Pixl starts instead of Explorer (no desktop-first flash). Login-item
// registration is only a fallback when Shell could not be written (avoids
// dual-start races when Shell already launches Pixl).
export function registerStartup(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return // don't register the dev/electron binary
  if (isAppFullyDisabled()) {
    bootLog('registerStartup skipped — app fully disabled')
    return
  }

  let shellOk = false
  try {
    // HKCU write — no elevation required. Takes effect on next logon.
    execFileSync(
      'reg',
      [
        'add',
        WINLOGON_KEY,
        '/v',
        'Shell',
        '/t',
        'REG_SZ',
        '/d',
        process.execPath,
        '/f'
      ],
      { windowsHide: true }
    )
    shellOk = true
    bootLog(`Winlogon Shell set to ${process.execPath}`)
  } catch (err) {
    console.warn('[startup] failed to set Winlogon Shell:', err)
    bootLog(`Winlogon Shell set FAILED: ${String(err)}`)
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: !shellOk,
      path: process.execPath,
      args: []
    })
    bootLog(
      shellOk
        ? 'login item disabled (Shell handles launch)'
        : 'login item enabled as Shell fallback'
    )
  } catch (err) {
    console.warn('[startup] failed to register login item:', err)
  }
}

/**
 * Undo Winlogon Shell + login-item autostart so the PC boots to Explorer.
 * Used by the persistent master-disable path (survives restarts).
 */
export function unregisterStartup(): void {
  if (process.platform !== 'win32') return

  if (app.isPackaged) {
    try {
      execFileSync(
        'reg',
        [
          'add',
          WINLOGON_KEY,
          '/v',
          'Shell',
          '/t',
          'REG_SZ',
          '/d',
          'explorer.exe',
          '/f'
        ],
        { windowsHide: true }
      )
      bootLog('Winlogon Shell restored to explorer.exe')
    } catch (err) {
      console.warn('[startup] failed to restore Winlogon Shell:', err)
      bootLog(`Winlogon Shell restore FAILED: ${String(err)}`)
    }
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath
    })
    bootLog('login item disabled (master disable)')
  } catch (err) {
    console.warn('[startup] failed to clear login item:', err)
  }
}
