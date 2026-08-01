// Money + time conversion helpers shared by main, preload, and renderer.
// Stored balances are always integers: money in centavos, time in seconds.
// Only the live open-time accrual held in session state may be fractional.

/** ₱1 in centavos. */
export const CENTAVOS_PER_PESO = 100

/**
 * Canonical wording for an empty money balance. Shown by the login gate and by
 * the lockscreen banner after an open-time session runs dry, so it lives here
 * rather than being spelled out in each.
 */
export const NO_CREDITS_MESSAGE = 'No credits — please top up at the counter'

/** One-tap buy-time presets, in centavos (₱1 / ₱5 / ₱10). */
export const BUY_TIME_PRESET_CENTAVOS = [100, 500, 1000]

/** Formats a centavo balance for display, e.g. 150 -> "₱1.50". */
export function formatPesos(centavos: number): string {
  const rounded = Math.round(centavos)
  const sign = rounded < 0 ? '-' : ''
  const abs = Math.abs(rounded)
  const pesos = Math.floor(abs / CENTAVOS_PER_PESO)
  const rest = abs % CENTAVOS_PER_PESO
  return `${sign}₱${pesos}.${String(rest).padStart(2, '0')}`
}

/** Converts a typed peso amount (may include centavos, e.g. 1.5) to centavos. */
export function pesosToCentavos(pesos: number): number {
  if (!Number.isFinite(pesos)) return 0
  return Math.round(pesos * CENTAVOS_PER_PESO)
}

export function centavosToPesos(centavos: number): number {
  return centavos / CENTAVOS_PER_PESO
}

/** Seconds of play that a centavo amount buys at the configured peso rate. */
export function centavosToSeconds(centavos: number, pesoToSecondsRate: number): number {
  if (pesoToSecondsRate <= 0) return 0
  return Math.round((centavos * pesoToSecondsRate) / CENTAVOS_PER_PESO)
}

/**
 * Money recovered when unused purchased time is refunded. Inverse of
 * centavosToSeconds, floored so we never over-credit, clamped at 0.
 */
export function secondsToCentavos(seconds: number, pesoToSecondsRate: number): number {
  if (pesoToSecondsRate <= 0) return 0
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.floor((seconds * CENTAVOS_PER_PESO) / pesoToSecondsRate)
}

/**
 * Centavos burned per second of open-time play. Deliberately fractional (at the
 * default rate of 360 s/₱1 this is 0.2777…); callers accumulate it and debit
 * only whole centavos so nothing is lost to rounding.
 */
export function centavosPerSecond(pesoToSecondsRate: number): number {
  if (pesoToSecondsRate <= 0) return 0
  return CENTAVOS_PER_PESO / pesoToSecondsRate
}
