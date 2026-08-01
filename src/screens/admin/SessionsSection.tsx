import { useEffect, useState, type JSX } from 'react'
import type { AccountPublic, SessionRowWithNames } from '@shared/types'
import { formatDuration, formatPesos } from '../../hooks/usePixl'
import { EmptyState, ModeChip, Panel, errText, whenFull, whenShort } from './AdminUi'

const LIMITS = [50, 100, 250]

export function SessionsSection({ version }: { version: number }): JSX.Element {
  const [sessions, setSessions] = useState<SessionRowWithNames[]>([])
  const [accounts, setAccounts] = useState<AccountPublic[]>([])
  const [accountId, setAccountId] = useState('')
  const [limit, setLimit] = useState(LIMITS[0])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.pixl
      .adminListAccounts()
      .then((rows) => {
        if (alive) setAccounts(rows)
      })
      .catch(() => {
        /* the filter just stays empty */
      })
    return () => {
      alive = false
    }
  }, [version])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const rows = await window.pixl.adminListSessions({
          accountId: accountId || undefined,
          limit
        })
        if (!alive) return
        setSessions(rows)
        setError(null)
      } catch (e) {
        if (alive) setError(errText(e, 'Could not load sessions'))
      }
    })()
    return () => {
      alive = false
    }
  }, [version, accountId, limit])

  const active = sessions.filter((s) => !s.ended_at).length

  return (
    <Panel
      title="Sessions"
      meta={`${sessions.length} shown · ${active} active`}
      actions={
        <>
          <div className="field adm-inline-field">
            <label className="lock-label" htmlFor="sess-account">
              Account
            </label>
            <select
              id="sess-account"
              className="input input-sm"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username}
                </option>
              ))}
            </select>
          </div>
          <div className="field adm-inline-field">
            <label className="lock-label" htmlFor="sess-limit">
              Rows
            </label>
            <select
              id="sess-limit"
              className="input input-sm"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMITS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </>
      }
    >
      {error ? (
        <p className="lock-error">{error}</p>
      ) : sessions.length === 0 ? (
        <EmptyState text="No sessions match this filter." />
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th>Account</th>
                <th>PC</th>
                <th>Mode</th>
                <th className="adm-num-col">Used</th>
                <th className="adm-num-col">Spent</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className={s.ended_at ? '' : 'is-live'}>
                  <td className="num muted" title={whenFull(s.started_at)}>
                    {whenShort(s.started_at)}
                  </td>
                  <td className="num muted" title={whenFull(s.ended_at)}>
                    {s.ended_at ? whenShort(s.ended_at) : <span className="adm-live">active</span>}
                  </td>
                  <td className="num">@{s.username || '—'}</td>
                  <td>{s.pc_name || '—'}</td>
                  <td>
                    <ModeChip mode={s.mode} />
                  </td>
                  <td className="adm-num-col num">{formatDuration(s.seconds_used)}</td>
                  <td className="adm-num-col num">
                    {s.centavos_used > 0 ? formatPesos(s.centavos_used) : '—'}
                  </td>
                  <td className="muted">{s.ended_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
