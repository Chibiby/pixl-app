// Watchdog loop. Runs as a Windows service via WinSW (pixlwatchdog.exe) under
// portable Node from %ProgramData%\Pixl\watchdog\node.exe. Every few seconds it
// checks whether the Pixl kiosk process is alive and relaunches it if not.
// Kept intentionally tiny and dependency-free so it is robust.

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CHECK_INTERVAL_MS = Number(process.env.PIXL_WATCHDOG_INTERVAL || 5000)
// Path to the installed Pixl executable. Set at service-install time.
const EXE_PATH = process.env.PIXL_EXE || ''
const EXE_NAME = EXE_PATH ? path.basename(EXE_PATH) : 'Pixl.exe'
const PUBLIC_DIR =
  process.env.PUBLIC || path.join(process.env.SystemDrive || 'C:', 'Users', 'Public')
const MAINTENANCE_FLAG = path.join(PUBLIC_DIR, 'Pixl', 'maintenance.stop')
// Persistent master-disable (survives reboot). Presence alone is enough.
const DISABLED_FLAG = path.join(PUBLIC_DIR, 'Pixl', 'disabled.flag')
// Allow a few seconds of clock/uptime skew between app and service.
const BOOT_STAMP_TOLERANCE_SEC = 5

function log(msg) {
  console.log(`[watchdog ${new Date().toISOString()}] ${msg}`)
}

function getBootStamp() {
  return Math.floor((Date.now() - os.uptime() * 1000) / 1000)
}

/** @returns {boolean} true if relaunch should be skipped (admin master-disable). */
function isAppDisabled() {
  return fs.existsSync(DISABLED_FLAG)
}

/** @returns {boolean} true if relaunch should be skipped (active maintenance). */
function isMaintenanceActive() {
  if (!fs.existsSync(MAINTENANCE_FLAG)) return false
  let flagStamp = NaN
  try {
    flagStamp = Number(fs.readFileSync(MAINTENANCE_FLAG, 'utf8').trim())
  } catch {
    try {
      fs.unlinkSync(MAINTENANCE_FLAG)
    } catch {
      /* ignore */
    }
    return false
  }
  if (!Number.isFinite(flagStamp)) {
    try {
      fs.unlinkSync(MAINTENANCE_FLAG)
    } catch {
      /* ignore */
    }
    return false
  }
  const boot = getBootStamp()
  if (Math.abs(flagStamp - boot) <= BOOT_STAMP_TOLERANCE_SEC) {
    return true
  }
  // Stale flag from a previous boot — clear and protect.
  try {
    fs.unlinkSync(MAINTENANCE_FLAG)
    log(`Cleared stale maintenance flag (flag=${flagStamp}, boot=${boot})`)
  } catch {
    /* ignore */
  }
  return false
}

function isRunning(cb) {
  // tasklist filtered by image name; if the name shows up, it's alive.
  execFile(
    'tasklist',
    ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH', '/FO', 'CSV'],
    { windowsHide: true },
    (err, stdout) => {
      if (err) return cb(false)
      cb(stdout.toLowerCase().includes(EXE_NAME.toLowerCase()))
    }
  )
}

function relaunch() {
  if (!EXE_PATH) {
    log('PIXL_EXE not configured; cannot relaunch.')
    return
  }
  log(`Relaunching ${EXE_PATH}`)
  const child = spawn(EXE_PATH, [], { detached: true, stdio: 'ignore' })
  child.unref()
}

function tick() {
  isRunning((alive) => {
    if (!alive) {
      log(`${EXE_NAME} not running.`)
      if (isAppDisabled()) {
        log('Disabled flag present; skipping relaunch (master disable).')
        return
      }
      if (isMaintenanceActive()) {
        log('Maintenance flag matches current boot; skipping relaunch.')
        return
      }
      relaunch()
    }
  })
}

log(`Watchdog started. Watching ${EXE_NAME} every ${CHECK_INTERVAL_MS}ms.`)
setInterval(tick, CHECK_INTERVAL_MS)
tick()
