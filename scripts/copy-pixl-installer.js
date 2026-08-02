// After electron-builder, also expose release/pixl.exe as the all-in-one cafe
// installer alias (versioned pixl-setup-*.exe remains the updater / GitHub asset).

const fs = require('fs')
const path = require('path')

const releaseDir = path.join(__dirname, '..', 'release')
const version = require('../package.json').version
const setupName = `pixl-setup-${version}.exe`
const setupPath = path.join(releaseDir, setupName)
const aliasPath = path.join(releaseDir, 'pixl.exe')

if (!fs.existsSync(setupPath)) {
  console.error(`ERROR: Expected installer not found: ${setupPath}`)
  process.exit(1)
}

fs.copyFileSync(setupPath, aliasPath)
console.log(`All-in-one installer ready:\n  ${setupPath}\n  ${aliasPath}`)
