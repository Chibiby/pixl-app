// Registers the Pixl watchdog as an auto-start Windows service using node-windows.
// Run from an elevated (Administrator) shell on a machine that has npm deps
// (the cafe build/checkout machine):
//   $env:PIXL_EXE = 'C:\Program Files\Pixl\Pixl.exe'
//   npm run watchdog:install
//
// The runner + WinSW daemon are copied to %ProgramData%\Pixl\watchdog so an
// NSIS reinstall of Pixl.exe does not delete the service binary.

const fs = require('fs')
const path = require('path')

const DEFAULT_EXE = 'C:\\Program Files\\Pixl\\Pixl.exe'
const DEFAULT_PACKAGED_SCRIPT =
  'C:\\Program Files\\Pixl\\resources\\watchdog\\watchdog-runner.js'
const REPO_SCRIPT = path.join(__dirname, '..', 'watchdog', 'watchdog-runner.js')
const PROGRAMDATA_DIR = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Pixl',
  'watchdog'
)
const PROGRAMDATA_SCRIPT = path.join(PROGRAMDATA_DIR, 'watchdog-runner.js')

let Service
try {
  Service = require('node-windows').Service
} catch (e) {
  console.error('node-windows is not installed. Run `npm install` first.')
  process.exit(1)
}

function resolveExe() {
  if (process.env.PIXL_EXE) return process.env.PIXL_EXE
  if (fs.existsSync(DEFAULT_EXE)) return DEFAULT_EXE
  return null
}

function resolveSourceScript() {
  if (process.env.PIXL_WATCHDOG_SCRIPT) return process.env.PIXL_WATCHDOG_SCRIPT
  if (fs.existsSync(DEFAULT_PACKAGED_SCRIPT)) return DEFAULT_PACKAGED_SCRIPT
  return REPO_SCRIPT
}

const exePath = resolveExe()
if (!exePath) {
  console.error('ERROR: Pixl executable not found.')
  console.error('  Set PIXL_EXE, or install Pixl to the default path:')
  console.error(`  ${DEFAULT_EXE}`)
  console.error("  e.g.  $env:PIXL_EXE = 'C:\\Program Files\\Pixl\\Pixl.exe'")
  process.exit(1)
}
if (!fs.existsSync(exePath)) {
  console.error(`ERROR: Pixl executable does not exist: ${exePath}`)
  console.error('  Set PIXL_EXE to the installed Pixl.exe path.')
  process.exit(1)
}

const sourceScript = resolveSourceScript()
if (!fs.existsSync(sourceScript)) {
  console.error(`ERROR: Watchdog script not found: ${sourceScript}`)
  console.error('  Set PIXL_WATCHDOG_SCRIPT, or ensure the packaged app includes')
  console.error(`  ${DEFAULT_PACKAGED_SCRIPT}`)
  console.error('  (or run from a full repo checkout with watchdog/watchdog-runner.js).')
  process.exit(1)
}

fs.mkdirSync(PROGRAMDATA_DIR, { recursive: true })
fs.copyFileSync(sourceScript, PROGRAMDATA_SCRIPT)
const scriptPath = PROGRAMDATA_SCRIPT

console.log(`Using PIXL_EXE=${exePath}`)
console.log(`Using watchdog script=${scriptPath} (copied from ${sourceScript})`)

const svc = new Service({
  name: 'PixlWatchdog',
  description: 'Relaunches the Pixl kiosk app if it is closed or killed.',
  script: scriptPath,
  env: [
    { name: 'PIXL_EXE', value: exePath },
    { name: 'PIXL_WATCHDOG_INTERVAL', value: process.env.PIXL_WATCHDOG_INTERVAL || '5000' }
  ],
  // Restart the service itself if it ever crashes.
  wait: 2,
  grow: 0.5,
  maxRestarts: 999999
})

svc.on('install', () => {
  console.log('PixlWatchdog installed. Starting service...')
  svc.start()
})
svc.on('alreadyinstalled', () => {
  console.log('PixlWatchdog already installed. Starting service...')
  try {
    svc.start()
  } catch (err) {
    console.warn('Could not start existing service:', err)
  }
})
svc.on('start', () => console.log('PixlWatchdog started.'))
svc.on('error', (err) => console.error('Service error:', err))

svc.install()
