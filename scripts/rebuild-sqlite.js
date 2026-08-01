// Fetches the prebuilt better-sqlite3 binary that matches the installed Electron
// ABI. This avoids needing Python + Visual Studio C++ build tools on the machine.
// Run after `npm install` (or after bumping Electron): `npm run rebuild`.

const { execFileSync } = require('child_process')
const { join } = require('path')

const electronVersion = require('electron/package.json').version
const bsqliteDir = join(__dirname, '..', 'node_modules', 'better-sqlite3')

console.log(`[rebuild-sqlite] Fetching better-sqlite3 prebuild for Electron ${electronVersion}...`)

try {
  execFileSync(
    process.execPath,
    [
      join(__dirname, '..', 'node_modules', 'prebuild-install', 'bin.js'),
      '--runtime',
      'electron',
      '--target',
      electronVersion,
      '--arch',
      process.arch
    ],
    { cwd: bsqliteDir, stdio: 'inherit' }
  )
  console.log('[rebuild-sqlite] Done. Native binary ready for Electron.')
} catch (err) {
  console.error(
    '[rebuild-sqlite] Prebuild download failed. If you have Python + VS Build Tools installed,\n' +
      'you can compile from source instead with:\n' +
      '  npx electron-rebuild -f -w better-sqlite3'
  )
  process.exit(1)
}
