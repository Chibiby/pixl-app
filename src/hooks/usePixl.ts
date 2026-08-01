import { useEffect, useState } from 'react'
import { centavosToSeconds } from '@shared/money'
import type { ModeState, SessionSnapshot, SyncStatus, UpdateStatus } from '@shared/types'

// Money formatting lives in @shared/money so main and renderer agree; it is
// re-exported here because every screen already imports from this module.
export { formatPesos, pesosToCentavos, centavosToSeconds } from '@shared/money'

// Mirrors the main-process default; only used until settings arrive over IPC.
const FALLBACK_PESO_TO_SECONDS_RATE = 360

// Subscribe to the main-process mode state (mode, account, message, online...).
export function useModeState(): ModeState | null {
  const [state, setState] = useState<ModeState | null>(null)
  useEffect(() => {
    let unsub = (): void => {}
    void window.pixl.getModeState().then(setState)
    unsub = window.pixl.onModeState(setState)
    return () => unsub()
  }, [])
  return state
}

// Subscribe to per-second session snapshots (tray popover).
export function useSessionTick(initial: SessionSnapshot | null): SessionSnapshot | null {
  const [snap, setSnap] = useState<SessionSnapshot | null>(initial)
  useEffect(() => {
    const unsub = window.pixl.onSessionTick(setSnap)
    return () => unsub()
  }, [])
  return snap
}

export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    let unsub = (): void => {}
    void window.pixl.getSyncStatus().then(setStatus)
    unsub = window.pixl.onSyncStatus(setStatus)
    return () => unsub()
  }, [])
  return status
}

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let unsub = (): void => {}
    void window.pixl.getUpdateStatus().then(setStatus)
    unsub = window.pixl.onUpdateStatus(setStatus)
    return () => unsub()
  }, [])
  return status
}

/**
 * Seconds of play bought per ₱1, read once from settings. Screens use it to
 * label buy-time amounts with real minutes instead of a hardcoded rate.
 */
export function usePesoRate(): number {
  const [rate, setRate] = useState(FALLBACK_PESO_TO_SECONDS_RATE)
  useEffect(() => {
    let alive = true
    void window.pixl
      .getSettings()
      .then((settings) => {
        if (alive && settings.pesoToSecondsRate > 0) setRate(settings.pesoToSecondsRate)
      })
      .catch(() => {
        /* keep the fallback rate */
      })
    return () => {
      alive = false
    }
  }, [])
  return rate
}

/** Whole minutes of play a centavo amount buys, for preset/custom labels. */
export function centavosToMinutes(centavos: number, pesoToSecondsRate: number): number {
  return Math.round(centavosToSeconds(centavos, pesoToSecondsRate) / 60)
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}
