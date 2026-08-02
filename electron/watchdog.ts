import { app } from 'electron'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isAppFullyDisabled } from './disable'

// Watchdog service control + maintenance pause. The service itself lives in
// ../watchdog/watchdog-runner.js and is installed via watchdog/install-service.js
// (WinSW + portable Node under %ProgramData%\Pixl\watchdog).

// WinSW <id> / service name (legacy node-windows used the same id; display name PixlWatchdog).
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

export function stopWatchdogService(): void {
  try {
    execFileSync('sc', ['stop', WATCHDOG_SERVICE_NAME], { windowsHide: true })
    console.log(`[watchdog] sc stop ${WATCHDOG_SERVICE_NAME} ok`)
  } catch {
    // May fail without elevation; flag is the reliable path.
  }
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
  stopWatchdogService()
}

export function ensureWatchdogProtection(): void {
  // Master disable must survive this call — never clear disabled.flag here.
  if (isAppFullyDisabled()) {
    console.log('[watchdog] app fully disabled; not starting protection')
    return
  }
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
  const packagedHint =
    `"C:\\Program Files\\Pixl\\resources\\watchdog\\install.cmd"`
  return (
    `Register the watchdog from an elevated shell (no repo / npm needed):\n` +
    `  ${packagedHint}\n` +
    `Or from a build machine: set PIXL_EXE=${getExecutablePath()} then ` +
    `npm run watchdog:install\n` +
    `Admin Quit (maintenance) writes %PUBLIC%\\Pixl\\maintenance.stop so the ` +
    `watchdog skips relaunch until Pixl starts again or the PC restarts. ` +
    `Master disable writes %PUBLIC%\\Pixl\\disabled.flag (survives reboot).`
  )
}

export function isPackaged(): boolean {
  return app.isPackaged
}
