import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Append a line to %ProgramData%\Pixl\pixl-boot.log for diagnosing
 * Winlogon-shell black screens on the next boot (no console attached).
 */
export function bootLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    // Always mirror to console for packaged logs / dev.
    console.log(`[boot] ${message}`)
  } catch {
    /* ignore */
  }
  try {
    const base = process.env.ProgramData || 'C:\\ProgramData'
    const file = join(base, 'Pixl', 'pixl-boot.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line, 'utf8')
  } catch {
    // best-effort — never throw during boot
  }
}

export function bootLogPath(): string {
  const base = process.env.ProgramData || 'C:\\ProgramData'
  return join(base, 'Pixl', 'pixl-boot.log')
}
