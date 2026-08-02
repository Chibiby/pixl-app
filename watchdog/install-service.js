// Self-contained PixlWatchdog installer (no node-windows / no repo node_modules).
//
// Cafe deploy choice: WinSW (pixlwatchdog.exe) + portable node.exe from
// resources/watchdog/runtime/ (or repo watchdog/runtime/). Both are copied to
// %ProgramData%\Pixl\watchdog so NSIS reinstalls of Pixl.exe do not remove them.
// The service still runs watchdog-runner.js under that Node; we do not use
// ELECTRON_RUN_AS_NODE (keeps the service independent of Electron updates).
//
// Elevated shell — packaged app:
//   "C:\Program Files\Pixl\resources\watchdog\install.cmd"
// Elevated shell — repo (after fetch-watchdog-runtime):
//   $env:PIXL_EXE = 'C:\Program Files\Pixl\Pixl.exe'
//   npm run watchdog:install

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const SERVICE_ID = 'pixlwatchdog.exe'
const SERVICE_DISPLAY = 'PixlWatchdog'
const DEFAULT_EXE = 'C:\\Program Files\\Pixl\\Pixl.exe'
const DEFAULT_PACKAGED_DIR = 'C:\\Program Files\\Pixl\\resources\\watchdog'
const PROGRAMDATA_DIR = path.join(
  process.env.ProgramData || 'C:\\ProgramData',
  'Pixl',
  'watchdog'
)

const WATCHDOG_DIR = __dirname
const REPO_WATCHDOG_DIR = WATCHDOG_DIR

function resolveExe() {
  // NSIS / install.cmd pass the installed Pixl.exe as argv[2] and set PIXL_EXE.
  const argExe = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null
  if (process.env.PIXL_EXE) return process.env.PIXL_EXE
  if (argExe && fs.existsSync(argExe)) return argExe
  if (fs.existsSync(DEFAULT_EXE)) return DEFAULT_EXE
  return null
}

function resolveSourceDir() {
  if (process.env.PIXL_WATCHDOG_DIR) return process.env.PIXL_WATCHDOG_DIR
  if (fs.existsSync(path.join(DEFAULT_PACKAGED_DIR, 'watchdog-runner.js'))) {
    return DEFAULT_PACKAGED_DIR
  }
  return REPO_WATCHDOG_DIR
}

function requireFile(filePath, hint) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Missing ${filePath}`)
    if (hint) console.error(`  ${hint}`)
    process.exit(1)
  }
}

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

function tryUninstallExisting() {
  const candidates = [
    path.join(PROGRAMDATA_DIR, SERVICE_ID),
    path.join(PROGRAMDATA_DIR, 'daemon', SERVICE_ID)
  ]
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue
    console.log(`Uninstalling existing service via ${exe}...`)
    try {
      runWinsw(exe, 'stop')
    } catch {
      /* ignore */
    }
    try {
      runWinsw(exe, 'uninstall')
      return
    } catch (err) {
      console.warn(`WinSW uninstall failed (${exe}):`, err.message || err)
    }
  }
  console.log(`Falling back to sc stop/delete ${SERVICE_ID}...`)
  sc(['stop', SERVICE_ID], { allowFail: true })
  // Brief pause so the SCM releases the binary handle.
  try {
    execFileSync('ping', ['127.0.0.1', '-n', '3'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  sc(['delete', SERVICE_ID], { allowFail: true })
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function writeServiceXml({ nodeExe, runnerJs, exePath, intervalMs }) {
  // Service <id> must remain pixlwatchdog.exe — electron/watchdog.ts uses
  // sc stop/start against that name (legacy node-windows contract).
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\r\n' +
    '<service>\r\n' +
    `  <id>${SERVICE_ID}</id>\r\n` +
    `  <name>${SERVICE_DISPLAY}</name>\r\n` +
    '  <description>Relaunches the Pixl kiosk app if it is closed or killed.</description>\r\n' +
    `  <executable>${escapeXml(nodeExe)}</executable>\r\n` +
    `  <argument>${escapeXml(runnerJs)}</argument>\r\n` +
    `  <workingdirectory>${escapeXml(PROGRAMDATA_DIR)}</workingdirectory>\r\n` +
    '  <startmode>Automatic</startmode>\r\n' +
    '  <logmode>rotate</logmode>\r\n' +
    '  <onfailure action="restart" delay="2 sec"/>\r\n' +
    '  <onfailure action="restart" delay="5 sec"/>\r\n' +
    '  <onfailure action="restart" delay="10 sec"/>\r\n' +
    '  <resetfailure>1 hour</resetfailure>\r\n' +
    `  <env name="PIXL_EXE" value="${escapeXml(exePath)}"/>\r\n` +
    `  <env name="PIXL_WATCHDOG_INTERVAL" value="${escapeXml(intervalMs)}"/>\r\n` +
    '</service>\r\n'
  fs.writeFileSync(path.join(PROGRAMDATA_DIR, 'pixlwatchdog.xml'), xml, 'utf8')
}

function main() {
  const exePath = resolveExe()
  if (!exePath) {
    console.error('ERROR: Pixl executable not found.')
    console.error('  Set PIXL_EXE, or install Pixl to the default path:')
    console.error(`  ${DEFAULT_EXE}`)
    process.exit(1)
  }
  if (!fs.existsSync(exePath)) {
    console.error(`ERROR: Pixl executable does not exist: ${exePath}`)
    process.exit(1)
  }

  const sourceDir = resolveSourceDir()
  const sourceRunner = process.env.PIXL_WATCHDOG_SCRIPT
    ? process.env.PIXL_WATCHDOG_SCRIPT
    : path.join(sourceDir, 'watchdog-runner.js')
  const sourceNode = path.join(sourceDir, 'runtime', 'node.exe')
  const sourceWinsw = path.join(sourceDir, 'runtime', 'winsw.exe')
  const sourceWinswConfig = path.join(sourceDir, 'runtime', 'winsw.exe.config')

  requireFile(sourceRunner, 'Packaged app should include resources\\watchdog\\watchdog-runner.js')
  requireFile(
    sourceNode,
    'Run: node scripts/fetch-watchdog-runtime.js  (or rebuild package:win)'
  )
  requireFile(
    sourceWinsw,
    'Run: node scripts/fetch-watchdog-runtime.js  (or rebuild package:win)'
  )

  const intervalMs = process.env.PIXL_WATCHDOG_INTERVAL || '5000'
  const destRunner = path.join(PROGRAMDATA_DIR, 'watchdog-runner.js')
  const destNode = path.join(PROGRAMDATA_DIR, 'node.exe')
  const destWinsw = path.join(PROGRAMDATA_DIR, SERVICE_ID)
  const destWinswConfig = path.join(PROGRAMDATA_DIR, `${SERVICE_ID}.config`)

  console.log(`Using PIXL_EXE=${exePath}`)
  console.log(`Using watchdog source=${sourceDir}`)
  console.log(`Installing into ${PROGRAMDATA_DIR}`)

  fs.mkdirSync(PROGRAMDATA_DIR, { recursive: true })
  tryUninstallExisting()

  fs.copyFileSync(sourceRunner, destRunner)
  fs.copyFileSync(sourceNode, destNode)
  fs.copyFileSync(sourceWinsw, destWinsw)
  if (fs.existsSync(sourceWinswConfig)) {
    fs.copyFileSync(sourceWinswConfig, destWinswConfig)
  } else {
    fs.writeFileSync(
      destWinswConfig,
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
        '<configuration>\r\n' +
        '\t<startup>\r\n' +
        '\t\t<supportedRuntime version="v4.0" />\r\n' +
        '\t</startup>\r\n' +
        '</configuration>\r\n',
      'utf8'
    )
  }

  writeServiceXml({
    nodeExe: destNode,
    runnerJs: destRunner,
    exePath,
    intervalMs
  })

  console.log(`Registering service ${SERVICE_ID} (display ${SERVICE_DISPLAY})...`)
  runWinsw(destWinsw, 'install')
  console.log('Starting service...')
  runWinsw(destWinsw, 'start')
  console.log('PixlWatchdog installed and started.')
  console.log(`  Service name: ${SERVICE_ID}`)
  console.log(`  Runner: ${destRunner}`)
  console.log(`  Node: ${destNode}`)
}

main()
