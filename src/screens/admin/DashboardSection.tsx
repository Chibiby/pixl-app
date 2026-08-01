import { useEffect, useState, type JSX } from 'react'
import type { AdminStats, LedgerRowWithNames } from '@shared/types'
import { formatPesos } from '../../hooks/usePixl'
import {
  EmptyState,
  KindChip,
  Panel,
  StatCard,
  StatusChip,
  errText,
  humanizeLedger,
  whenFull,
  whenShort
} from './AdminUi'

/** The dashboard re-reads its aggregates on this cadence so it feels live. */
const POLL_MS = 20000

const RECENT_ACTIVITY_ROWS = 10

export function DashboardSection({ version }: { version: number }): JSX.Element {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [activity, setActivity] = useState<LedgerRowWithNames[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [next, ledger] = await Promise.all([
          window.pixl.adminGetStats(),
          window.pixl.adminListLedger({ limit: RECENT_ACTIVITY_ROWS })
        ])
        if (!alive) return
        setStats(next)
        setActivity(ledger.rows)
        setError(null)
      } catch (e) {
        if (alive) setError(errText(e, 'Could not load the dashboard'))
      }
    })()
    return () => {
      alive = false
    }
  }, [version, tick])

  if (error) return <p className="lock-error">{error}</p>
  if (!stats) return <p className="adm-loading">Loading figures…</p>

  return (
    <div className="adm-stack">
      <div className="adm-stats">
        <StatCard
          label="Revenue today"
          value={formatPesos(stats.revenueTodayCentavos)}
          hint="Counter top-ups"
          tone="accent"
        />
        <StatCard
          label="Revenue 7 days"
          value={formatPesos(stats.revenueWeekCentavos)}
          hint="Top-ups, rolling week"
        />
        <StatCard
          label="Open-time spend today"
          value={formatPesos(stats.openTimeSpendTodayCentavos)}
          hint="Credits burned by play"
        />
        <StatCard
          label="Active sessions"
          value={String(stats.activeSessions)}
          hint={`${stats.pcs.length} PC${stats.pcs.length === 1 ? '' : 's'} known`}
          tone={stats.activeSessions > 0 ? 'ok' : 'default'}
        />
        <StatCard label="Accounts" value={String(stats.accountCount)} hint="Registered customers" />
        <StatCard
          label="Outstanding credits"
          value={formatPesos(stats.totalOutstandingCentavos)}
          hint="Unspent money — liability"
          tone="warn"
        />
      </div>

      <div className="adm-two-col">
        <RevenueChart stats={stats} />
        <Panel
          title="Recent activity"
          meta={`last ${activity.length} movement${activity.length === 1 ? '' : 's'}`}
        >
          {activity.length === 0 ? (
            <EmptyState text="No credit movements yet." />
          ) : (
            <ul className="adm-feed">
              {activity.map((row) => (
                <li className="adm-feed-row" key={row.id}>
                  <KindChip kind={row.kind} />
                  <span className="adm-feed-text num">{humanizeLedger(row)}</span>
                  <span className="adm-feed-when num" title={whenFull(row.created_at)}>
                    {whenShort(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Stations"
        meta={`updated ${whenShort(stats.generatedAt)}`}
      >
        {stats.pcs.length === 0 ? (
          <EmptyState text="No PCs have checked in yet." />
        ) : (
          <div className="adm-pcs">
            {stats.pcs.map((pc) => (
              <div className={'adm-pc is-' + pc.status} key={pc.id}>
                <div className="adm-pc-top">
                  <span className="adm-pc-name">{pc.name}</span>
                  <StatusChip status={pc.status} />
                </div>
                <span className="adm-pc-meta num" title={whenFull(pc.last_seen_at)}>
                  seen {whenShort(pc.last_seen_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

/**
 * Seven-day revenue bars. Heights are percentages of the busiest day, so the
 * chart is pure CSS — no library, no canvas.
 */
function RevenueChart({ stats }: { stats: AdminStats }): JSX.Element {
  const max = stats.dailyRevenue.reduce((m, d) => Math.max(m, d.centavos), 0)
  return (
    <Panel title="Revenue, last 7 days" meta={`peak ${formatPesos(max)}`}>
      <div className="adm-chart" role="img" aria-label="Daily top-up revenue for the last 7 days">
        {stats.dailyRevenue.map((d) => {
          // A non-zero day never renders as an invisible sliver.
          const pct = max === 0 ? 0 : Math.max(d.centavos > 0 ? 3 : 0, (d.centavos / max) * 100)
          return (
            <div className="adm-chart-col" key={d.day} title={`${d.day} · ${formatPesos(d.centavos)}`}>
              <span className="adm-chart-value num">{compactPesos(d.centavos)}</span>
              <div className="adm-chart-track">
                <div
                  className={'adm-chart-bar' + (d.centavos === 0 ? ' is-empty' : '')}
                  style={{ height: `${pct}%` }}
                />
              </div>
              <span className="adm-chart-day">{weekday(d.day)}</span>
            </div>
          )
        })}
      </div>
      <p className="adm-chart-foot">
        Days are UTC, matching how the ledger stores timestamps.
      </p>
    </Panel>
  )
}

/** Short bar label: ₱0, ₱240, ₱1.2k. */
function compactPesos(centavos: number): string {
  const pesos = Math.round(centavos / 100)
  if (pesos >= 1000) return `₱${(pesos / 1000).toFixed(1)}k`
  return `₱${pesos}`
}

function weekday(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day.slice(5)
  return d.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' })
}
