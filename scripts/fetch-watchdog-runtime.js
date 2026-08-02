// Downloads portable Node + WinSW into watchdog/runtime/ so cafe installs do not
// need a repo checkout or npm deps. Run automatically before package:win, or:
//   node scripts/fetch-watchdog-runtime.js
//
// Choice (cafe deploy): ship a portable node.exe next to the runner. WinSW
// launches that Node; we do not rely on system Node or ELECTRON_RUN_AS_NODE.

const fs = require('fs')
const https = require('https')
const path = require('path')
const { execFileSync } = require('child_process')

const RUNTIME_DIR = path.join(__dirname, '..', 'watchdog', 'runtime')
const NODE_VERSION = process.env.PIXL_WATCHDOG_NODE_VERSION || 'v22.14.0'
const WINSW_VERSION = process.env.PIXL_WATCHDOG_WINSW_VERSION || 'v2.12.0'
// .NET Framework build (~0.6MB) — Windows 10+ cafe PCs already have .NET 4.x.
// Prefer over the 17MB self-contained WinSW-x64.exe.
const WINSW_URL =
  process.env.PIXL_WATCHDOG_WINSW_URL ||
  `https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/WinSW.NET461.exe`
const NODE_ZIP_URL =
  process.env.PIXL_WATCHDOG_NODE_URL ||
  `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`

const NODE_EXE = path.join(RUNTIME_DIR, 'node.exe')
const WINSW_EXE = path.join(RUNTIME_DIR, 'winsw.exe')
const WINSW_CONFIG = path.join(RUNTIME_DIR, 'winsw.exe.config')

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = (u, redirectsLeft) => {
      https
        .get(u, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume()
            return get(res.headers.location, redirectsLeft - 1)
          }
          if (res.statusCode !== 200) {
            file.close()
            fs.unlink(dest, () => {})
            return reject(new Error(`GET ${u} → HTTP ${res.statusCode}`))
          }
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve(dest)))
        })
        .on('error', (err) => {
          file.close()
          fs.unlink(dest, () => {})
          reject(err)
        })
    }
    get(url, 8)
  })
}

function extractNodeExe(zipPath) {
  const staging = path.join(RUNTIME_DIR, '_node_extract')
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  // PowerShell Expand-Archive is available on cafe/build Windows hosts.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${staging.replace(/'/g, "''")}' -Force`
    ],
    { stdio: 'inherit' }
  )
  const entries = fs.readdirSync(staging)
  const root = entries.find((name) => name.startsWith('node-') && name.includes('win-x64'))
  if (!root) {
    throw new Error(`Could not find node-*-win-x64 folder inside ${zipPath}`)
  }
  const extracted = path.join(staging, root, 'node.exe')
  if (!fs.existsSync(extracted)) {
    throw new Error(`node.exe missing from extracted zip at ${extracted}`)
  }
  fs.copyFileSync(extracted, NODE_EXE)
  fs.rmSync(staging, { recursive: true, force: true })
}

function writeWinswConfig() {
  // Allows WinSW.NET461.exe to run under .NET 4.x (same idea as node-windows).
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\r\n' +
    '<configuration>\r\n' +
    '\t<startup>\r\n' +
    '\t\t<supportedRuntime version="v4.0" />\r\n' +
    '\t</startup>\r\n' +
    '</configuration>\r\n'
  fs.writeFileSync(WINSW_CONFIG, xml, 'utf8')
}

async function main() {
  const force = process.argv.includes('--force')
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })

  if (!force && fs.existsSync(NODE_EXE) && fs.existsSync(WINSW_EXE)) {
    console.log(`Watchdog runtime already present in ${RUNTIME_DIR} (use --force to refresh).`)
    if (!fs.existsSync(WINSW_CONFIG)) writeWinswConfig()
    return
  }

  console.log(`Fetching WinSW ${WINSW_VERSION} → ${WINSW_EXE}`)
  await download(WINSW_URL, WINSW_EXE)
  writeWinswConfig()

  const zipPath = path.join(RUNTIME_DIR, `node-${NODE_VERSION}-win-x64.zip`)
  console.log(`Fetching Node ${NODE_VERSION} → ${zipPath}`)
  await download(NODE_ZIP_URL, zipPath)
  console.log(`Extracting node.exe → ${NODE_EXE}`)
  extractNodeExe(zipPath)
  fs.unlinkSync(zipPath)

  console.log('Watchdog runtime ready:')
  console.log(`  ${NODE_EXE}`)
  console.log(`  ${WINSW_EXE}`)
  console.log(`  ${WINSW_CONFIG}`)
}

main().catch((err) => {
  console.error('Failed to fetch watchdog runtime:', err.message || err)
  process.exit(1)
})
