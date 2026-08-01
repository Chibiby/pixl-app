import { useEffect, useState, type JSX } from 'react'
import type { AccountPublic, AdminLedgerPage, LedgerKind, LedgerRowWithNames } from '@shared/types'
import { formatDuration } from '../../hooks/usePixl'
import {
  EmptyState,
  KIND_LABEL,
  KindChip,
  LEDGER_KINDS,
  Panel,
  deltaTone,
  errText,
  signedDuration,
  signedPesos,
  whenFull,
  whenShort
} from './AdminUi'

/** Play summaries show time used; money-only rows show —. */
function timeCell(row: LedgerRowWithNames): string {
  if (row.kind === 'session' || row.kind === 'open_time') {
    return row.delta_seconds === 0 ? '—' : formatDuration(Math.abs(row.delta_seconds))
  }
  return signedDuration(row.delta_seconds)
}

const PAGE_SIZE = 25

export function TransactionsSection({ version }: { version: number }): JSX.Element {
  const [page, setPage] = useState<AdminLedgerPage | null>(null)
  const [accounts, setAccounts] = useState<AccountPublic[]>([])
  const [kind, setKind] = useState<LedgerKind | ''>('')
  const [accountId, setAccountId] = useState('')
  const [offset, setOffset] = useState(0)
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

  // A narrowed filter can leave the current offset past the end of the result.
  useEffect(() => {
    setOffset(0)
  }, [kind, accountId])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const next = await window.pixl.adminListLedger({
          accountId: accountId || undefined,
          kinds: kind ? [kind] : undefined,
          limit: PAGE_SIZE,
          offset
        })
        if (!alive) return
        setPage(next)
        setError(null)
      } catch (e) {
        if (alive) setError(errText(e, 'Could not load transactions'))
      }
    })()
    return () => {
      alive = false
    }
  }, [version, kind, accountId, offset])

  const total = page?.total ?? 0
  const rows = page?.rows ?? []
  const from = total === 0 ? 0 : offset + 1
  const to = offset + rows.length
  const canPrev = offset > 0
  const canNext = to < total

  return (
    <Panel
      title="Transactions"
      meta={`${from}–${to} of ${total}`}
      actions={
        <>
          <div className="field adm-inline-field">
            <label className="lock-label" htmlFor="tx-kind">
              Kind
            </label>
            <select
              id="tx-kind"
              className="input input-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as LedgerKind | '')}
            >
              <option value="">All kinds</option>
              {LEDGER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field adm-inline-field">
            <label className="lock-label" htmlFor="tx-account">
              Account
            </label>
            <select
              id="tx-account"
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
        </>
      }
    >
      {error ? (
        <p className="lock-error">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState text="No movements match this filter." />
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Account</th>
                <th className="adm-num-col">Money</th>
                <th className="adm-num-col">Time</th>
                <th>Note</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num muted" title={whenFull(row.created_at)}>
                    {whenShort(row.created_at)}
                  </td>
                  <td>
                    <KindChip kind={row.kind} />
                  </td>
                  <td className="num">@{row.username || '—'}</td>
                  <td className={'adm-num-col num ' + deltaTone(row.delta_centavos)}>
                    {row.delta_centavos === 0 ? '—' : signedPesos(row.delta_centavos)}
                  </td>
                  <td
                    className={
                      'adm-num-col num ' +
                      (row.kind === 'session' || row.kind === 'open_time'
                        ? row.delta_seconds < 0
                          ? 'is-neg'
                          : ''
                        : deltaTone(row.delta_seconds))
                    }
                  >
                    {timeCell(row)}
                  </td>
                  <td className="muted adm-note-col">{row.note ?? '—'}</td>
                  <td className="num muted">
                    {row.admin_username ? '@' + row.admin_username : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="adm-pager">
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={!canPrev}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          ← Newer
        </button>
        <span className="adm-pager-meta num">
          page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={!canNext}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Older →
        </button>
      </div>
    </Panel>
  )
}
