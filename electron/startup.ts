import { app } from 'electron'
import { execFile } from 'child_process'

const WINLOGON_KEY =
  'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'

// Register the app to auto-launch at Windows login. Prefer Winlogon Shell so
// Pixl starts instead of Explorer (no desktop-first flash). Login-item
// registration remains as a fallback if Shell was cleared.
export function registerStartup(): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return // don't register the dev/electron binary
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: []
    })
  } catch (err) {
    console.warn('[startup] failed to register login item:', err)
  }
  try {
    // HKCU write — no elevation required. Takes effect on next logon.
    execFile(
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
      { windowsHide: true },
      (err) => {
        if (err) console.warn('[startup] failed to set Winlogon Shell:', err)
        else console.log('[startup] Winlogon Shell set to', process.execPath)
      }
    )
  } catch (err) {
    console.warn('[startup] failed to set Winlogon Shell:', err)
  }
}
