import type { JSX, ReactNode } from 'react'
import type {
  AccountRole,
  LedgerKind,
  LedgerRowWithNames,
  PcStatus,
  SessionMode
} from '@shared/types'
import { formatDuration, formatPesos } from '../../hooks/usePixl'

// Small presentational pieces shared by the admin sections: inline feedback
// notes (same pattern as the tray HUD), chips, stat cards and the ledger
// wording used by the credits / session views.

export interface Note {
  tone: 'ok' | 'err'
  text: string
}

/** Inline result line placed next to the button that caused it. */
export function NoteLine({ note }: { note: Note | null }): JSX.Element | null {
  if (!note) return null
  return (
    <p className={'adm-note ' + (note.tone === 'ok' ? 'is-ok' : 'is-err')} aria-live="polite">
      {note.text}
    </p>
  )
}

/**
 * Message for a failed IPC call. Electron wraps a main-process throw as
 * "Error invoking remote method 'admin:x': Error: <real message>", which is
 * noise next to a button, so the real message is unwrapped when present.
 */
export function errText(e: unknown, fallback: string): string {
  if (!(e instanceof Error) || !e.message) return fallback
  const unwrapped = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(
    e.message
  )
  return (unwrapped?.[1] ?? e.message).trim() || fallback
}

// ---------------------------------------------------------------- chips

export function RoleChip({ role }: { role: AccountRole }): JSX.Element {
  return <span className={'adm-chip is-role-' + role}>{role}</span>
}

export function StatusChip({ status }: { status: PcStatus }): JSX.Element {
  const label = status === 'in_session' ? 'in session' : status
  return <span className={'adm-chip is-pc-' + status}>{label}</span>
}

export function ModeChip({ mode }: { mode: SessionMode }): JSX.Element {
  return <span className={'adm-chip is-mode-' + mode}>{mode === 'open' ? 'open time' : 'timed'}</span>
}

export function KindChip({ kind }: { kind: LedgerKind }): JSX.Element {
  return <span className={'adm-chip is-kind-' + kind}>{KIND_LABEL[kind]}</span>
}

export const KIND_LABEL: Record<LedgerKind, string> = {
  topup: 'Top-up',
  buy_time: 'Buy time',
  sell_time: 'Sell time',
  open_time: 'Open play',
  session: 'Play',
  grant: 'Grant',
  adjust: 'Adjustment'
}

/** Lower-case wording for prose like the activity feed. */
const KIND_PHRASE: Record<LedgerKind, string> = {
  topup: 'top-up',
  buy_time: 'buy time',
  sell_time: 'sell time',
  open_time: 'open play',
  session: 'play',
  grant: 'grant',
  adjust: 'adjustment'
}

export const LEDGER_KINDS: LedgerKind[] = [
  'topup',
  'buy_time',
  'sell_time',
  'open_time',
  'session',
  'grant',
  'adjust'
]

// ------------------------------------------------------- ledger wording

/** Signed money, e.g. "+₱50.00" / "−₱2.00" (true minus sign, not a hyphen). */
export function signedPesos(centavos: number): string {
  if (centavos === 0) return formatPesos(0)
  return (centavos > 0 ? '+' : '−') + formatPesos(Math.abs(centavos))
}

export function signedDuration(seconds: number): string {
  if (seconds === 0) return '—'
  return (seconds > 0 ? '+' : '−') + formatDuration(Math.abs(seconds))
}

/** Cell tint class for a signed delta: green in, red out, plain zero. */
export function deltaTone(delta: number): string {
  if (delta > 0) return 'is-pos'
  if (delta < 0) return 'is-neg'
  return ''
}

export function whenFull(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export function whenShort(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "+₱50.00 top-up → juan by admin" — one readable line per ledger row. */
export function humanizeLedger(row: LedgerRowWithNames): string {
  const parts: string[] = []
  if (row.delta_centavos !== 0) parts.push(signedPesos(row.delta_centavos))
  if (row.delta_seconds !== 0) parts.push(signedDuration(row.delta_seconds))
  const amount = parts.length > 0 ? parts.join(' · ') : '—'
  const who = row.username || 'unknown account'
  const by = row.admin_username ? ` by ${row.admin_username}` : ''
  return `${amount} ${KIND_PHRASE[row.kind]} → ${who}${by}`
}

// ------------------------------------------------------------------- surfaces

export function StatCard({
  label,
  value,
  hint,
  tone = 'default'
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'accent' | 'warn' | 'ok'
}): JSX.Element {
  return (
    <div className={'adm-stat is-' + tone}>
      <span className="adm-stat-label">{label}</span>
      <span className="adm-stat-value num">{value}</span>
      {hint && <span className="adm-stat-hint">{hint}</span>}
    </div>
  )
}

export function Panel({
  title,
  meta,
  actions,
  children,
  className
}: {
  title: string
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={'card adm-panel' + (className ? ' ' + className : '')}>
      <div className="adm-panel-head">
        <div className="adm-panel-titles">
          <h2 className="adm-panel-title">{title}</h2>
          {meta && <span className="adm-panel-meta">{meta}</span>}
        </div>
        {actions && <div className="adm-panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ text }: { text: string }): JSX.Element {
  return <p className="adm-empty">{text}</p>
}
