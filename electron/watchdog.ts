import { app } from 'electron'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Watchdog service control + maintenance pause. The service itself lives in
// ../watchdog/watchdog-runner.js and is installed via scripts/watchdog-install.js.

// node-windows registers the service id as lowercase + .exe (display name is PixlWatchdog).
export const WATCHDOG_SERVICE_NAME = 'pixlwatchdog.exe'

export function getExecutablePath(): string {
  return process.execPath
}

export function getMaintenanceFlagPath(): string {
  // Public profile is writable by limited cafe users and readable by the
  // SYSTEM-run watchdog service (Program Files / ProgramData often are not).
  const publicDir =
    process.env.PUBLIC || path.join(process.env.SystemDrive || 'C:', 'Users', 'Public')
  return path.join(publicDir, 'Pixl', 'maintenance.stop')
}

/** Stable-enough boot id (seconds since epoch of last boot). Works without PowerShell. */
export function getBootStamp(): string {
  return String(Math.floor((Date.now() - os.uptime() * 1000) / 1000))
}

export function enterMaintenanceMode(): void {
  const flagPath = getMaintenanceFlagPath()
  const dir = path.dirname(flagPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const stamp = getBootStamp()
    fs.writeFileSync(flagPath, stamp, 'utf8')
    console.log(`[watchdog] maintenance mode entered (boot=${stamp})`)
  } catch (err) {
    console.warn('[watchdog] failed to write maintenance flag:', err)
  }
  try {
    execFileSync('sc', ['stop', WATCHDOG_SERVICE_NAME], { windowsHide: true })
    console.log(`[watchdog] sc stop ${WATCHDOG_SERVICE_NAME} ok`)
  } catch {
    // May fail without elevation; flag is the reliable path.
  }
}

export function ensureWatchdogProtection(): void {
  const flagPath = getMaintenanceFlagPath()
  try {
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath)
      console.log('[watchdog] cleared maintenance flag; protection resumed')
    }
  } catch (err) {
    console.warn('[watchdog] failed to clear maintenance flag:', err)
  }
  try {
    execFileSync('sc', ['start', WATCHDOG_SERVICE_NAME], { windowsHide: true })
    console.log(`[watchdog] sc start ${WATCHDOG_SERVICE_NAME} ok`)
  } catch {
    // May fail without elevation / if not installed; flag clear is enough.
  }
}

export function watchdogInstallHint(): string {
  return (
    `Register the watchdog from an elevated shell:\n` +
    `  set PIXL_EXE=${getExecutablePath()}\n` +
    `  npm run watchdog:install\n` +
    `Admin Quit (maintenance) writes %PUBLIC%\\Pixl\\maintenance.stop so the ` +
    `watchdog skips relaunch until Pixl starts again or the PC restarts.`
  )
}

export function isPackaged(): boolean {
  return app.isPackaged
}
