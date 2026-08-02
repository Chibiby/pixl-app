// Removes the PixlWatchdog Windows service. Self-contained (no node-windows).
//
// Elevated shell — packaged app:
//   "C:\Program Files\Pixl\resources\watchdog\uninstall.cmd"
// Elevated shell — repo:
//   npm run watchdog:uninstall

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const SERVICE_ID = 'pixlwatchdog.exe'
const PROGRAMDATA_DIR = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Pixl',
  'watchdog'
)

function sc(args, { allowFail = false } = {}) {
  try {
    execFileSync('sc.exe', args, { windowsHide: true, stdio: 'pipe' })
    return true
  } catch (err) {
    if (allowFail) return false
    throw err
  }
}

function runWinsw(exePath, verb) {
  execFileSync(exePath, [verb], {
    cwd: path.dirname(exePath),
    windowsHide: true,
    stdio: 'inherit'
  })
}

function main() {
  const removeFiles = process.argv.includes('--remove-files')
  const candidates = [
    path.join(PROGRAMDATA_DIR, SERVICE_ID),
    path.join(PROGRAMDATA_DIR, 'daemon', SERVICE_ID)
  ]

  let uninstalled = false
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue
    console.log(`Uninstalling via ${exe}...`)
    try {
      runWinsw(exe, 'stop')
    } catch {
      /* ignore */
    }
    try {
      runWinsw(exe, 'uninstall')
      uninstalled = true
      break
    } catch (err) {
      console.warn(`WinSW uninstall failed (${exe}):`, err.message || err)
    }
  }

  if (!uninstalled) {
    console.log(`Falling back to sc stop/delete ${SERVICE_ID}...`)
    sc(['stop', SERVICE_ID], { allowFail: true })
    try {
      execFileSync('ping', ['127.0.0.1', '-n', '3'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    if (sc(['delete', SERVICE_ID], { allowFail: true })) {
      uninstalled = true
    }
  }

  if (uninstalled) {
    console.log('PixlWatchdog service removed.')
  } else {
    console.log('PixlWatchdog service was not installed (or already removed).')
  }

  if (removeFiles && fs.existsSync(PROGRAMDATA_DIR)) {
    console.log(`Removing ${PROGRAMDATA_DIR}...`)
    fs.rmSync(PROGRAMDATA_DIR, { recursive: true, force: true })
    console.log('ProgramData watchdog files removed.')
  } else if (!removeFiles) {
    console.log(`Left files in ${PROGRAMDATA_DIR} (pass --remove-files to delete).`)
  }
}

main()
