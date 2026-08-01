import type { AppSettings } from '@shared/types'
import { getRuntimeConfig } from './config'
import { getSetting, setSetting } from './sync/sqlite'

// App settings live in the SQLite `settings` table so they persist per-PC. The
// admin machine flag comes from .env and disables idle auto-shutdown.

const DEFAULTS = {
  pesoToSecondsRate: 360, // ₱1 = 6 minutes
  idleShutdownSeconds: 180, // 3 minutes when no user is logged in
  reminderThresholdsSeconds: [300, 60]
}

const KEYS = {
  rate: 'peso_to_seconds_rate',
  idle: 'idle_shutdown_seconds',
  reminders: 'reminder_thresholds_seconds'
}

export function getSettings(): AppSettings {
  const cfg = getRuntimeConfig()
  const rate = numOr(getSetting(KEYS.rate), DEFAULTS.pesoToSecondsRate)
  const idle = numOr(getSetting(KEYS.idle), DEFAULTS.idleShutdownSeconds)
  const reminders = arrOr(getSetting(KEYS.reminders), DEFAULTS.reminderThresholdsSeconds)
  return {
    pesoToSecondsRate: rate,
    // On the admin machine, force idle shutdown off so it never kills itself.
    idleShutdownSeconds: cfg.adminMachine ? 0 : idle,
    reminderThresholdsSeconds: reminders,
    isAdminMachine: cfg.adminMachine
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (typeof patch.pesoToSecondsRate === 'number' && patch.pesoToSecondsRate > 0) {
    setSetting(KEYS.rate, String(Math.round(patch.pesoToSecondsRate)))
  }
  if (typeof patch.idleShutdownSeconds === 'number' && patch.idleShutdownSeconds >= 0) {
    setSetting(KEYS.idle, String(Math.round(patch.idleShutdownSeconds)))
  }
  if (Array.isArray(patch.reminderThresholdsSeconds)) {
    setSetting(KEYS.reminders, JSON.stringify(patch.reminderThresholdsSeconds))
  }
  return getSettings()
}

function numOr(v: string | null, fallback: number): number {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function arrOr(v: string | null, fallback: number[]): number[] {
  if (v == null) return fallback
  try {
    const parsed = JSON.parse(v)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'number')) return parsed
  } catch {
    /* ignore */
  }
  return fallback
}
