import fs from 'fs'
import path from 'path'

// Persistent master-disable flag. Unlike maintenance.stop (boot-scoped), this
// survives restarts so the PC can stay non-kiosk until an admin re-enables.

export function getDisabledFlagPath(): string {
  // Public profile is writable by limited cafe users and readable by the
  // SYSTEM-run watchdog service (Program Files / ProgramData often are not).
  const publicDir =
    process.env.PUBLIC || path.join(process.env.SystemDrive || 'C:', 'Users', 'Public')
  return path.join(publicDir, 'Pixl', 'disabled.flag')
}

export function isAppFullyDisabled(): boolean {
  try {
    return fs.existsSync(getDisabledFlagPath())
  } catch {
    return false
  }
}

/**
 * Write or clear disabled.flag. Throws on I/O failure so callers can abort
 * disable/enable before changing autostart or quitting.
 */
export function setAppFullyDisabled(disabled: boolean): void {
  const flagPath = getDisabledFlagPath()
  const dir = path.dirname(flagPath)
  try {
    if (disabled) {
      fs.mkdirSync(dir, { recursive: true })
      // ISO timestamp — not a boot stamp; must survive reboot.
      fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8')
      if (!fs.existsSync(flagPath)) {
        throw new Error(`disabled.flag missing after write (${flagPath})`)
      }
      console.log(`[disable] app fully disabled (flag=${flagPath})`)
    } else {
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath)
      }
      if (fs.existsSync(flagPath)) {
        throw new Error(`disabled.flag still present after clear (${flagPath})`)
      }
      console.log('[disable] app re-enabled; disabled.flag cleared')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[disable] failed to update disabled.flag:', err)
    throw new Error(`Could not update disabled.flag: ${msg}`)
  }
}
