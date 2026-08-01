import { app } from 'electron'
import { config as loadDotenv } from 'dotenv'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import os from 'os'

function programDataEnvPath(): string {
  const base = process.env.ProgramData || 'C:\\ProgramData'
  return join(base, 'Pixl', '.env')
}

function userDataEnvPath(): string {
  try {
    return join(app.getPath('userData'), '.env')
  } catch {
    return ''
  }
}

/**
 * Prefer machine-local env that survives NSIS updates (ProgramData / userData).
 * Fall back to packaged/resources copies for first install.
 */
function resolveEnvPath(): string | null {
  const candidates = [
    programDataEnvPath(),
    userDataEnvPath(),
    join(process.cwd(), '.env'),
    join(app.getAppPath(), '.env'),
    join(process.resourcesPath ?? '', '.env')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** Copy a found env into ProgramData so the next update cannot wipe it. */
function persistEnvToProgramData(source: string): void {
  const dest = programDataEnvPath()
  if (!dest || source === dest) return
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (!existsSync(dest)) {
      copyFileSync(source, dest)
      console.log('[config] persisted .env to', dest)
    }
  } catch (err) {
    console.warn('[config] could not persist .env to ProgramData:', err)
  }
}

const resolved = resolveEnvPath()
if (resolved) {
  loadDotenv({ path: resolved })
  if (app.isPackaged) persistEnvToProgramData(resolved)
}

export interface RuntimeConfig {
  supabaseUrl: string
  supabaseAnonKey: string
  pcName: string
  adminMachine: boolean
  hasSupabase: boolean
  /**
   * Development-only login bypass. When true, the fixed dev credentials
   * (admin/admin) unlock straight into the admin panel with no database.
   * On for unpackaged (dev) builds; in a packaged build only when
   * PIXL_DEV_BYPASS=1 is explicitly set, and force-off with PIXL_DEV_BYPASS=0.
   */
  devBypass: boolean
}

export function getRuntimeConfig(): RuntimeConfig {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() ?? ''
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? ''
  const hasSupabase =
    supabaseUrl.length > 0 &&
    supabaseAnonKey.length > 0 &&
    !supabaseUrl.includes('your-project-ref')

  const bypassEnv = process.env.PIXL_DEV_BYPASS?.trim()
  const devBypass = bypassEnv === '0' ? false : bypassEnv === '1' ? true : !app.isPackaged

  return {
    supabaseUrl,
    supabaseAnonKey,
    pcName: process.env.PIXL_PC_NAME?.trim() || os.hostname(),
    adminMachine: process.env.PIXL_ADMIN_MACHINE?.trim() === '1',
    hasSupabase,
    devBypass
  }
}
