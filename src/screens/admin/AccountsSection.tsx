import { useEffect, useMemo, useState, type JSX } from 'react'
import type { AccountPublic, AccountRole } from '@shared/types'
import { formatPesos, usePesoRate } from '../../hooks/usePixl'
import { PasswordInput } from '../../components/PasswordInput'
import { AccountDrawer } from './AccountDrawer'
import { IconPlus, IconSearch } from './icons'
import {
  EmptyState,
  type Note,
  NoteLine,
  Panel,
  RoleChip,
  errText,
  whenFull,
  whenShort
} from './AdminUi'

type SortKey = 'username' | 'display_name' | 'credits' | 'updated'

export function AccountsSection({
  version,
  onChanged
}: {
  version: number
  onChanged: () => void
}): JSX.Element {
  const rate = usePesoRate()
  const [accounts, setAccounts] = useState<AccountPublic[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'username',
    desc: false
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const rows = await window.pixl.adminListAccounts()
        if (!alive) return
        setAccounts(rows)
        setError(null)
      } catch (e) {
        if (alive) setError(errText(e, 'Could not load accounts'))
      }
    })()
    return () => {
      alive = false
    }
  }, [version])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? accounts.filter(
          (a) =>
            a.username.toLowerCase().includes(needle) ||
            a.display_name.toLowerCase().includes(needle)
        )
      : accounts
    const dir = sort.desc ? -1 : 1
    return [...filtered].sort((a, b) => dir * compare(a, b, sort.key))
  }, [accounts, query, sort])

  const selected = accounts.find((a) => a.id === selectedId) ?? null

  function toggleSort(key: SortKey): void {
    setSort((prev) =>
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: key !== 'username' }
    )
  }

  function sortMark(key: SortKey): string {
    if (sort.key !== key) return ''
    return sort.desc ? ' ↓' : ' ↑'
  }

  return (
    <div className="adm-stack">
      {creating && (
        <CreateAccountForm
          onCreated={() => {
            setCreating(false)
            onChanged()
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <Panel
        title="Accounts"
        meta={`${visible.length} of ${accounts.length}`}
        actions={
          <>
            <div className="adm-search">
              <IconSearch className="adm-search-icon" />
              <label className="sr-only" htmlFor="adm-account-search">
                Search accounts
              </label>
              <input
                id="adm-account-search"
                className="input input-sm adm-search-input"
                type="search"
                placeholder="Search username or name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => setCreating((c) => !c)}
            >
              <IconPlus />
              New account
            </button>
          </>
        }
      >
        {error ? (
          <p className="lock-error">{error}</p>
        ) : visible.length === 0 ? (
          <EmptyState
            text={accounts.length === 0 ? 'No accounts yet.' : 'No account matches that search.'}
          />
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>
                    <button className="adm-th" type="button" onClick={() => toggleSort('username')}>
                      Username{sortMark('username')}
                    </button>
                  </th>
                  <th>
                    <button
                      className="adm-th"
                      type="button"
                      onClick={() => toggleSort('display_name')}
                    >
                      Display name{sortMark('display_name')}
                    </button>
                  </th>
                  <th>Role</th>
                  <th className="adm-num-col">
                    <button className="adm-th" type="button" onClick={() => toggleSort('credits')}>
                      Credits{sortMark('credits')}
                    </button>
                  </th>
                  <th className="adm-num-col">
                    <button className="adm-th" type="button" onClick={() => toggleSort('updated')}>
                      Updated{sortMark('updated')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr
                    key={a.id}
                    className={'adm-row-click' + (selectedId === a.id ? ' is-selected' : '')}
                    onClick={() => setSelectedId(a.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedId(a.id)
                      }
                    }}
                  >
                    <td className="num">@{a.username}</td>
                    <td>{a.display_name || '—'}</td>
                    <td>
                      <RoleChip role={a.role} />
                    </td>
                    <td className="adm-num-col num">{formatPesos(a.credits_centavos)}</td>
                    <td className="adm-num-col num muted" title={whenFull(a.updated_at)}>
                      {whenShort(a.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && (
        <AccountDrawer
          account={selected}
          rate={rate}
          version={version}
          onChanged={onChanged}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

function compare(a: AccountPublic, b: AccountPublic, key: SortKey): number {
  switch (key) {
    case 'credits':
      return a.credits_centavos - b.credits_centavos
    case 'updated':
      return a.updated_at.localeCompare(b.updated_at)
    case 'display_name':
      return (a.display_name || a.username).localeCompare(b.display_name || b.username)
    case 'username':
    default:
      return a.username.localeCompare(b.username)
  }
}

function CreateAccountForm({
  onCreated,
  onCancel
}: {
  onCreated: () => void
  onCancel: () => void
}): JSX.Element {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AccountRole>('client')
  const [initialPesos, setInitialPesos] = useState('0')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)

  async function submit(): Promise<void> {
    if (busy) return
    if (!username.trim() || !password) {
      setNote({ tone: 'err', text: 'Username and password are required' })
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const created = await window.pixl.adminCreateAccount({
        username: username.trim(),
        password,
        displayName: displayName.trim(),
        role,
        initialPesos: Number(initialPesos) || 0
      })
      setNote({ tone: 'ok', text: `Created @${created.username}` })
      setUsername('')
      setDisplayName('')
      setPassword('')
      setRole('client')
      setInitialPesos('0')
      onCreated()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Could not create the account') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="New account"
      meta="created locally, queued for the server"
      actions={
        <button className="btn btn-ghost btn-sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      }
    >
      <div className="adm-grid-3">
        <div className="field">
          <label className="lock-label" htmlFor="new-username">
            Username
          </label>
          <input
            id="new-username"
            className="input input-sm"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="lock-label" htmlFor="new-display">
            Display name
          </label>
          <input
            id="new-display"
            className="input input-sm"
            placeholder="defaults to the username"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="lock-label" htmlFor="new-password">
            Password
          </label>
          <PasswordInput
            id="new-password"
            className="input input-sm"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="lock-label" htmlFor="new-role">
            Role
          </label>
          <select
            id="new-role"
            className="input input-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as AccountRole)}
          >
            <option value="client">client</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="field">
          <label className="lock-label" htmlFor="new-pesos">
            Opening credits (₱)
          </label>
          <input
            id="new-pesos"
            className="input input-sm num"
            type="number"
            min="0"
            step="0.01"
            value={initialPesos}
            onChange={(e) => setInitialPesos(e.target.value)}
          />
        </div>
        <div className="field adm-field-end">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? <span className="spinner" /> : 'Create account'}
          </button>
        </div>
      </div>
      <NoteLine note={note} />
    </Panel>
  )
}
