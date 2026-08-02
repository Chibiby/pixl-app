import { execFile } from 'child_process'
import { app } from 'electron'

/**
 * Guard: never actually shut down when running unpackaged/dev, or when
 * explicitly disabled via PIXL_NO_SHUTDOWN=1.
 *
 * Packaged cafe installs use app.isPackaged — Electron often leaves NODE_ENV
 * unset at runtime, so gating on NODE_ENV === 'production' silently no-ops
 * idle auto-shutdown after the lockscreen countdown hits zero.
 */
function shutdownEnabled(): boolean {
  if (process.env.PIXL_NO_SHUTDOWN === '1') return false
  if (app.isPackaged) return true
  // Unpackaged: opt-in only (e.g. production-build smoke tests).
  return process.env.PIXL_ALLOW_SHUTDOWN === '1'
}

export function shutdownWindows(reason: string): void {
  if (process.platform !== 'win32') {
    console.log(`[shutdown] (noop non-win32) reason=${reason}`)
    return
  }
  if (!shutdownEnabled()) {
    console.log(`[shutdown] suppressed (dev/guard) reason=${reason}`)
    return
  }
  // /s shutdown, /t 5, force via /c message for the cafe operator.
  execFile('shutdown', ['/s', '/t', '5', '/c', `Pixl: ${reason}`], (err) => {
    if (err) console.error('[shutdown] failed:', err)
  })
}
