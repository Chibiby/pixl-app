import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Returns a stable per-machine identifier. Prefers the Windows Cryptography
// MachineGuid; falls back to a UUID persisted in userData so it stays stable.
export function getMachineId(): string {
  const winGuid = readWindowsMachineGuid()
  if (winGuid) return winGuid

  const file = join(app.getPath('userData'), 'machine-id')
  try {
    if (existsSync(file)) {
      const cached = readFileSync(file, 'utf8').trim()
      if (cached) return cached
    }
    const generated = randomUUID()
    writeFileSync(file, generated, 'utf8')
    return generated
  } catch {
    // Last-resort ephemeral id (won't persist across restarts).
    return randomUUID()
  }
}

function readWindowsMachineGuid(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
    const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}
