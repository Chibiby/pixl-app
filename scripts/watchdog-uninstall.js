// Removes the Pixl watchdog Windows service. Run from an elevated shell:
//   npm run watchdog:uninstall

const fs = require('fs')
const path = require('path')

const DEFAULT_PACKAGED_SCRIPT =
  'C:\\Program Files\\Pixl\\resources\\watchdog\\watchdog-runner.js'
const REPO_SCRIPT = path.join(__dirname, '..', 'watchdog', 'watchdog-runner.js')
const PROGRAMDATA_SCRIPT = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Pixl',
  'watchdog',
  'watchdog-runner.js'
)

let Service
try {
  Service = require('node-windows').Service
} catch (e) {
  console.error('node-windows is not installed. Run `npm install` first.')
  process.exit(1)
}

function resolveScript() {
  if (process.env.PIXL_WATCHDOG_SCRIPT) return process.env.PIXL_WATCHDOG_SCRIPT
  if (fs.existsSync(PROGRAMDATA_SCRIPT)) return PROGRAMDATA_SCRIPT
  if (fs.existsSync(DEFAULT_PACKAGED_SCRIPT)) return DEFAULT_PACKAGED_SCRIPT
  return REPO_SCRIPT
}

const scriptPath = resolveScript()
console.log(`Uninstalling service for script=${scriptPath}`)

const svc = new Service({
  name: 'PixlWatchdog',
  script: scriptPath
})

svc.on('uninstall', () => console.log('PixlWatchdog uninstalled.'))
svc.on('alreadyuninstalled', () => console.log('PixlWatchdog already uninstalled.'))
svc.on('error', (err) => console.error('Service error:', err))

svc.uninstall()
