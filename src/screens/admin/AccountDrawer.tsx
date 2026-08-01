import { useEffect, useState, type JSX } from 'react'
import type {
  AccountPublic,
  AccountRole,
  LedgerRowWithNames,
  SessionRowWithNames
} from '@shared/types'
import {
  centavosToMinutes,
  formatDuration,
  formatPesos,
  pesosToCentavos
} from '../../hooks/usePixl'
import { IconClose } from './icons'
import {
  EmptyState,
  KindChip,
  ModeChip,
  type Note,
  NoteLine,
  RoleChip,
  errText,
  signedDuration,
  signedPesos,
  whenFull,
  whenShort
} from './AdminUi'

/** Counter presets, in pesos. */
const TOPUP_PRESETS = [20, 50, 100]

const HISTORY_ROWS = 8

type DrawerTab = 'actions' | 'history'

/**
 * Right-hand detail panel for one account: credits, money/profile actions,
 * delete, and that account's own ledger and session history. Rendered as an
 * overlay so it works at the admin window's 800px minimum width.
 */
export function AccountDrawer({
  account,
  rate,
  version,
  onChanged,
  onClose
}: {
  account: AccountPublic
  rate: number
  version: number
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = useState<DrawerTab>('actions')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="adm-drawer-backdrop" onClick={onClose} />
      <aside className="adm-drawer" aria-label={`Account ${account.username}`}>
        <header className="adm-drawer-head">
          <div className="adm-drawer-id">
            <span className="adm-drawer-name">{account.display_name || account.username}</span>
            <span className="adm-drawer-user num">@{account.username}</span>
          </div>
          <div className="adm-drawer-head-right">
            <RoleChip role={account.role} />
            <button
              className="btn btn-ghost btn-sm adm-icon-btn"
              type="button"
              onClick={onClose}
              aria-label="Close account panel"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="adm-drawer-balances adm-drawer-balances-single">
          <div className="adm-drawer-balance">
            <span className="adm-drawer-balance-label">Credits</span>
            <span className="adm-drawer-balance-value num">
              {formatPesos(account.credits_centavos)}
            </span>
            <span className="adm-drawer-balance-hint num">
              buys {centavosToMinutes(account.credits_centavos, rate)} min · updated{' '}
              {whenShort(account.updated_at)}
            </span>
          </div>
        </div>

        <div className="adm-tabs" role="tablist">
          {(['actions', 'history'] as DrawerTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={'adm-tab' + (tab === t ? ' is-active' : '')}
              onClick={() => setTab(t)}
            >
              {t === 'actions' ? 'Actions' : 'History'}
            </button>
          ))}
        </div>

        <div className="adm-drawer-body">
          {tab === 'actions' ? (
            <>
              <TopUpForm account={account} rate={rate} onDone={onChanged} />
              <AdjustForm account={account} onDone={onChanged} />
              <EditForm account={account} onDone={onChanged} />
              <DeleteForm
                account={account}
                onDone={() => {
                  onChanged()
                  onClose()
                }}
              />
            </>
          ) : (
            <AccountHistory accountId={account.id} version={version} />
          )}
        </div>
      </aside>
    </>
  )
}

// -------------------------------------------------------------------- top up

function TopUpForm({
  account,
  rate,
  onDone
}: {
  account: AccountPublic
  rate: number
  onDone: () => void
}): JSX.Element {
  const [pesos, setPesos] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)

  const customCentavos = pesosToCentavos(Number(pesos))
  const customValid = customCentavos > 0

  async function apply(amountPesos: number, key: string): Promise<void> {
    if (busy) return
    setBusy(key)
    setNote(null)
    try {
      const updated = await window.pixl.adminAddCredits({
        accountId: account.id,
        pesos: amountPesos,
        note: 'counter top-up'
      })
      setNote({
        tone: 'ok',
        text: `Added ${formatPesos(pesosToCentavos(amountPesos))} — balance ${formatPesos(updated.credits_centavos)}`
      })
      if (key === 'custom') setPesos('')
      onDone()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Top-up failed') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="adm-action">
      <div className="adm-action-head">
        <h3 className="adm-action-title">Top up</h3>
        <span className="adm-action-meta num">₱1 ≈ {centavosToMinutes(100, rate)} min</span>
      </div>
      <div className="adm-preset-grid">
        {TOPUP_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="buy-chip"
            disabled={busy !== null}
            onClick={() => void apply(p, `p${p}`)}
          >
            <span className="buy-chip-peso num">{formatPesos(p * 100)}</span>
            <span className="buy-chip-min">{centavosToMinutes(p * 100, rate)} min</span>
          </button>
        ))}
      </div>
      <div className="adm-row">
        <label className="sr-only" htmlFor={`topup-${account.id}`}>
          Custom top-up in pesos
        </label>
        <div className="amount">
          <span className="amount-peso" aria-hidden="true">
            ₱
          </span>
          <input
            id={`topup-${account.id}`}
            className="input input-sm amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={pesos}
            onChange={(e) => setPesos(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={busy !== null || !customValid}
          onClick={() => void apply(Number(pesos), 'custom')}
        >
          {busy === 'custom' ? <span className="spinner" /> : 'Add'}
        </button>
      </div>
      {customValid && (
        <p className="adm-hint num">
          Buys up to {centavosToMinutes(customCentavos, rate)} min of play
        </p>
      )}
      <NoteLine note={note} />
    </section>
  )
}

// ------------------------------------------------------------------- adjust

function AdjustForm({
  account,
  onDone
}: {
  account: AccountPublic
  onDone: () => void
}): JSX.Element {
  const [pesos, setPesos] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  const deltaPesos = Number(pesos) || 0
  const moves = deltaPesos !== 0
  const negative = deltaPesos < 0
  const valid = moves && reason.trim().length > 0

  async function submit(): Promise<void> {
    if (busy || !valid) return
    if (negative) {
      if (
        !confirm(
          `Deduct ${formatPesos(pesosToCentavos(deltaPesos))} from ${account.username}? This cannot be undone.`
        )
      ) {
        return
      }
    }
    setBusy(true)
    setNote(null)
    try {
      const updated = await window.pixl.adminAdjustBalance({
        accountId: account.id,
        deltaPesos,
        note: reason.trim()
      })
      setNote({
        tone: 'ok',
        text: `Credits now ${formatPesos(updated.credits_centavos)}`
      })
      setPesos('')
      setReason('')
      onDone()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Adjustment failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="adm-action">
      <div className="adm-action-head">
        <h3 className="adm-action-title">Adjust credits</h3>
        <span className="adm-action-meta">signed correction</span>
      </div>
      <div className="field">
        <label className="lock-label" htmlFor={`adj-pesos-${account.id}`}>
          Pesos ±
        </label>
        <input
          id={`adj-pesos-${account.id}`}
          className="input input-sm num"
          type="number"
          step="0.01"
          placeholder="-10.00"
          value={pesos}
          onChange={(e) => setPesos(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="lock-label" htmlFor={`adj-note-${account.id}`}>
          Reason (required)
        </label>
        <input
          id={`adj-note-${account.id}`}
          className="input input-sm"
          type="text"
          placeholder="e.g. double-charged at the counter"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <button
        className={'btn btn-sm ' + (negative ? 'btn-danger' : '')}
        type="button"
        disabled={busy || !valid}
        onClick={() => void submit()}
      >
        {busy ? <span className="spinner" /> : negative ? 'Deduct' : 'Apply adjustment'}
      </button>
      <p className="adm-hint">Credits stop at zero, and the ledger records what actually moved.</p>
      <NoteLine note={note} />
    </section>
  )
}

// --------------------------------------------------------------------- edit

function EditForm({
  account,
  onDone
}: {
  account: AccountPublic
  onDone: () => void
}): JSX.Element {
  const [displayName, setDisplayName] = useState(account.display_name)
  const [role, setRole] = useState<AccountRole>(account.role)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  // Re-seed when the admin switches to a different account in the same slot.
  // Keyed on the id alone: refreshing after a save must not wipe the fields or
  // the success note the save just wrote.
  useEffect(() => {
    setDisplayName(account.display_name)
    setRole(account.role)
    setPassword('')
    setConfirmPassword('')
    setNote(null)
  }, [account.id])

  const nameChanged = displayName.trim() !== account.display_name
  const roleChanged = role !== account.role
  const resetting = password.length > 0
  const dirty = nameChanged || roleChanged || resetting

  async function submit(): Promise<void> {
    if (busy || !dirty) return
    if (displayName.trim().length === 0) {
      setNote({ tone: 'err', text: 'Display name cannot be empty' })
      return
    }
    if (resetting && password !== confirmPassword) {
      setNote({ tone: 'err', text: 'The two passwords do not match' })
      return
    }
    if (roleChanged && !confirm(`Change ${account.username} from ${account.role} to ${role}?`)) {
      return
    }
    if (resetting && !confirm(`Reset the password for ${account.username}?`)) return

    setBusy(true)
    setNote(null)
    try {
      await window.pixl.adminUpdateAccount({
        accountId: account.id,
        displayName: displayName.trim(),
        role,
        newPassword: resetting ? password : undefined
      })
      setNote({ tone: 'ok', text: 'Account updated' })
      setPassword('')
      setConfirmPassword('')
      onDone()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Update failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="adm-action">
      <div className="adm-action-head">
        <h3 className="adm-action-title">Edit account</h3>
        <span className="adm-action-meta num">@{account.username} is fixed</span>
      </div>
      <div className="adm-grid-2">
        <div className="field">
          <label className="lock-label" htmlFor={`edit-name-${account.id}`}>
            Display name
          </label>
          <input
            id={`edit-name-${account.id}`}
            className="input input-sm"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="lock-label" htmlFor={`edit-role-${account.id}`}>
            Role
          </label>
          <select
            id={`edit-role-${account.id}`}
            className="input input-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as AccountRole)}
          >
            <option value="client">client</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="field">
          <label className="lock-label" htmlFor={`edit-pw-${account.id}`}>
            New password
          </label>
          <input
            id={`edit-pw-${account.id}`}
            className="input input-sm"
            type="password"
            autoComplete="new-password"
            placeholder="leave blank to keep"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="lock-label" htmlFor={`edit-pw2-${account.id}`}>
            Confirm password
          </label>
          <input
            id={`edit-pw2-${account.id}`}
            className="input input-sm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
      </div>
      <button
        className="btn btn-sm"
        type="button"
        disabled={busy || !dirty}
        onClick={() => void submit()}
      >
        {busy ? <span className="spinner" /> : 'Save changes'}
      </button>
      <NoteLine note={note} />
    </section>
  )
}

// ------------------------------------------------------------------- delete

function DeleteForm({
  account,
  onDone
}: {
  account: AccountPublic
  onDone: () => void
}): JSX.Element {
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  useEffect(() => {
    setConfirmName('')
    setNote(null)
  }, [account.id])

  const matches = confirmName.trim().toLowerCase() === account.username.toLowerCase()

  async function submit(): Promise<void> {
    if (busy || !matches) return
    if (
      !confirm(
        `Permanently delete @${account.username}? Local ledger and session history for this account will be removed.`
      )
    ) {
      return
    }
    setBusy(true)
    setNote(null)
    try {
      await window.pixl.adminDeleteAccount(account.id)
      onDone()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Could not delete the account') })
      setBusy(false)
    }
  }

  return (
    <section className="adm-action adm-action-danger">
      <div className="adm-action-head">
        <h3 className="adm-action-title">Delete account</h3>
        <span className="adm-action-meta">permanent · local</span>
      </div>
      <p className="adm-hint">
        Type <span className="num">@{account.username}</span> to confirm. Cannot delete the only
        admin or an account with an active session.
      </p>
      <div className="adm-row">
        <label className="sr-only" htmlFor={`del-${account.id}`}>
          Type username to confirm delete
        </label>
        <input
          id={`del-${account.id}`}
          className="input input-sm"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={account.username}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <button
          className="btn btn-danger btn-sm"
          type="button"
          disabled={busy || !matches}
          onClick={() => void submit()}
        >
          {busy ? <span className="spinner" /> : 'Delete'}
        </button>
      </div>
      <NoteLine note={note} />
    </section>
  )
}

// ------------------------------------------------------------------ history

function AccountHistory({
  accountId,
  version
}: {
  accountId: string
  version: number
}): JSX.Element {
  const [ledger, setLedger] = useState<LedgerRowWithNames[]>([])
  const [sessions, setSessions] = useState<SessionRowWithNames[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [page, rows] = await Promise.all([
          window.pixl.adminListLedger({ accountId, limit: HISTORY_ROWS }),
          window.pixl.adminListSessions({ accountId, limit: HISTORY_ROWS })
        ])
        if (!alive) return
        setLedger(page.rows)
        setSessions(rows)
        setError(null)
      } catch (e) {
        if (alive) setError(errText(e, 'Could not load history'))
      }
    })()
    return () => {
      alive = false
    }
  }, [accountId, version])

  if (error) return <p className="lock-error">{error}</p>

  return (
    <>
      <section className="adm-action">
        <div className="adm-action-head">
          <h3 className="adm-action-title">Recent movements</h3>
        </div>
        {ledger.length === 0 ? (
          <EmptyState text="Nothing on the ledger yet." />
        ) : (
          <ul className="adm-mini-list">
            {ledger.map((row) => (
              <li className="adm-mini-row" key={row.id}>
                <KindChip kind={row.kind} />
                <span className="adm-mini-main num">
                  {row.delta_centavos !== 0 && signedPesos(row.delta_centavos)}
                  {row.delta_centavos !== 0 && row.delta_seconds !== 0 && ' · '}
                  {row.delta_seconds !== 0 && signedDuration(row.delta_seconds)}
                </span>
                <span className="adm-mini-when num" title={whenFull(row.created_at)}>
                  {whenShort(row.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="adm-action">
        <div className="adm-action-head">
          <h3 className="adm-action-title">Recent sessions</h3>
        </div>
        {sessions.length === 0 ? (
          <EmptyState text="No sessions on record." />
        ) : (
          <ul className="adm-mini-list">
            {sessions.map((s) => (
              <li className="adm-mini-row" key={s.id}>
                <ModeChip mode={s.mode} />
                <span className="adm-mini-main num">
                  {formatDuration(s.seconds_used)}
                  {s.centavos_used > 0 && ` · ${formatPesos(s.centavos_used)}`}
                  {!s.ended_at && ' · active'}
                </span>
                <span className="adm-mini-when num" title={whenFull(s.started_at)}>
                  {whenShort(s.started_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
