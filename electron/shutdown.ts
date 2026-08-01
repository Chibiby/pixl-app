import { execFile } from 'child_process'

// Guard: never actually shut down when running in dev or when explicitly
// disabled via env. Tests and `npm run dev` set PIXL_NO_SHUTDOWN=1.
function shutdownEnabled(): boolean {
  if (process.env.PIXL_NO_SHUTDOWN === '1') return false
  if (!process.env.NODE_ENV) return process.env.PIXL_ALLOW_SHUTDOWN === '1' ? true : false
  return process.env.NODE_ENV === 'production' && process.env.PIXL_NO_SHUTDOWN !== '1'
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
  // /s shutdown, /t 0 immediately, /f force close apps.
  execFile('shutdown', ['/s', '/t', '5', '/c', `Pixl: ${reason}`], (err) => {
    if (err) console.error('[shutdown] failed:', err)
  })
}
