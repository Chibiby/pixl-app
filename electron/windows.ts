import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { appIcon } from './assets'

// Centralised window creation. Handles loading the correct renderer route in
// both dev (Vite dev server) and production (built files).

const PRELOAD = join(__dirname, '../preload/preload.js')

// Windows 11 draws rounded corners on every top-level window, which reveals the
// desktop (white) behind the lockscreen's corners. We can't fully cover the
// screen with square corners from user mode, so we bleed the window a few px
// past each edge of the monitor: the rounded corners land off-screen and only
// the square, fully-covered interior is visible.
const LOCK_BLEED = 8

function loadRoute(win: BrowserWindow, route: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/index.html#/${route}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

export function createLockWindow(
  display: Electron.Display,
  role: 'primary' | 'secondary'
): BrowserWindow {
  const { bounds } = display
  const covered = {
    x: bounds.x - LOCK_BLEED,
    y: bounds.y - LOCK_BLEED,
    width: bounds.width + LOCK_BLEED * 2,
    height: bounds.height + LOCK_BLEED * 2
  }
  const win = new BrowserWindow({
    x: covered.x,
    y: covered.y,
    width: covered.width,
    height: covered.height,
    frame: false,
    fullscreen: false, // we manage bounds manually for multi-monitor coverage
    roundedCorners: false, // avoid Win11 corner rounding revealing the desktop
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    kiosk: false,
    backgroundColor: '#0b1020',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setBounds(covered)
  loadRoute(win, role === 'primary' ? 'lock?role=primary' : 'lock?role=secondary')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
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
  })
  return win
}
