import { app } from 'electron'
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'
import os from 'os'

// Load .env from the project root in dev, or next to the executable in prod.
const envCandidates = [
  join(process.cwd(), '.env'),
  join(app.getAppPath(), '.env'),
  join(process.resourcesPath ?? '', '.env')
]
for (const p of envCandidates) {
  if (p && existsSync(p)) {
    loadDotenv({ path: p })
    break
  }
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
