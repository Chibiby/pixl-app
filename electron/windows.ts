import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { appIcon } from './assets'
import { bootLog } from './bootLog'
import { forceShellForeground, isPixlWinlogonShell } from './startup'

// Centralised window creation. Handles loading the correct renderer route in
// both dev (Vite dev server) and production (built files).

const PRELOAD = join(__dirname, '../preload/preload.js')

// Windows 11 draws rounded corners on every top-level window, which reveals the
// desktop (white) behind the lockscreen's corners. We can't fully cover the
// screen with square corners from user mode, so we bleed the window a few px
// past each edge of the monitor: the rounded corners land off-screen and only
// the square, fully-covered interior is visible.
const LOCK_BLEED = 8

/** Tracks lock BrowserWindows so rebuilds can sweep orphans left by races. */
const lockWindowSet = new WeakSet<BrowserWindow>()

export function isLockWindow(win: BrowserWindow): boolean {
  return lockWindowSet.has(win)
}

function markLockWindow(win: BrowserWindow): void {
  lockWindowSet.add(win)
}

function loadRoute(win: BrowserWindow, route: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/index.html#/${route}`)
  } else {
    // join(__dirname, ...) is absolute — safe when Winlogon starts us with cwd=System32.
    const html = join(__dirname, '../renderer/index.html')
    bootLog(`loadFile ${html}#/${route}`)
    void win.loadFile(html, { hash: `/${route}` })
  }
}

function assertLockVisible(win: BrowserWindow, reason: string, focus = false): void {
  if (win.isDestroyed()) return
  try {
    if (!win.isVisible()) win.show()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    if (focus) {
      forceShellForeground(win)
    }
    bootLog(
      `lock visible (${reason}) bounds=${JSON.stringify(win.getBounds())} ` +
        `isVisible=${win.isVisible()} isFocused=${win.isFocused()}`
    )
  } catch (err) {
    bootLog(`assertLockVisible failed (${reason}): ${String(err)}`)
  }
}

export function createLockWindow(
  display: Electron.Display,
  role: 'primary' | 'secondary'
): BrowserWindow {
  const { bounds } = display
  const shellMode = isPixlWinlogonShell()
  const covered = {
    x: bounds.x - LOCK_BLEED,
    y: bounds.y - LOCK_BLEED,
    width: bounds.width + LOCK_BLEED * 2,
    height: bounds.height + LOCK_BLEED * 2
  }
  bootLog(
    `createLockWindow role=${role} shell=${shellMode} display=${JSON.stringify(bounds)}`
  )

  const win = new BrowserWindow({
    x: covered.x,
    y: covered.y,
    width: covered.width,
    height: covered.height,
    frame: false,
    // Shell replacement: fullscreen/kiosk is more reliable than manual bleed
    // bounds when Explorer/DWM never started. Non-shell keeps bleed coverage.
    fullscreen: shellMode,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: true,
    kiosk: shellMode,
    backgroundColor: '#0b1020',
    // Show immediately so backgroundColor covers the desktop while the
    // renderer loads. Relying solely on ready-to-show can leave a black
    // screen when Tray is created first (Electron win32 quirk).
    show: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // Tag immediately so a mid-construction race can still sweep this window.
  markLockWindow(win)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (shellMode) {
    try {
      win.setKiosk(true)
      win.setFullScreen(true)
    } catch {
      /* ignore */
    }
  } else {
    win.setBounds(covered)
  }

  win.once('ready-to-show', () => {
    assertLockVisible(win, 'ready-to-show', role === 'primary')
  })
  win.webContents.once('did-finish-load', () => {
    assertLockVisible(win, 'did-finish-load', role === 'primary')
    if (shellMode) {
      try {
        win.setKiosk(true)
        win.setFullScreen(true)
      } catch {
        /* ignore */
      }
      forceShellForeground(win)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog(`did-fail-load code=${code} desc=${desc} url=${url}`)
    console.warn(`[lock] did-fail-load code=${code} desc=${desc} url=${url}`)
    // Retry once — cold shell boot sometimes races the asar extract/path.
    setTimeout(() => {
      if (!win.isDestroyed()) {
        bootLog('retrying loadRoute after did-fail-load')
        loadRoute(
          win,
          role === 'primary' ? 'lock?role=primary' : 'lock?role=secondary'
        )
      }
    }, 500)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    bootLog(`render-process-gone reason=${details.reason} exit=${details.exitCode}`)
  })
  win.on('unresponsive', () => {
    bootLog('lock window unresponsive')
  })

  // Layered visibility asserts — shell cold start often needs several kicks.
  for (const ms of shellMode ? [300, 1000, 2500, 5000, 10000] : [1500]) {
    setTimeout(() => {
      assertLockVisible(win, `timer-${ms}ms`, role === 'primary' && ms >= 1000)
    }, ms)
  }

  loadRoute(win, role === 'primary' ? 'lock?role=primary' : 'lock?role=secondary')
  if (role === 'primary') forceShellForeground(win)
  return win
}

export function createTrayPopover(): BrowserWindow {
  const win = new BrowserWindow({
    // Sized to the session HUD layout in src/screens/TrayPopover.css.
    width: 352,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  loadRoute(win, 'tray')
  win.on('blur', () => {
    if (!win.isDestroyed()) win.hide()
  })
  return win
}

export function createAdminWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay()
  const w = Math.min(1100, primary.workAreaSize.width - 80)
  const h = Math.min(760, primary.workAreaSize.height - 80)
  const win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 800,
    minHeight: 600,
    center: true,
    frame: true,
    title: 'Pixl Admin',
    icon: appIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  loadRoute(win, 'admin')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    forceShellForeground(win)
  })
  return win
}
