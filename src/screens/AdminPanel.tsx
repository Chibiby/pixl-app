import { useCallback, useState, type JSX } from 'react'
import type { UpdateStatus } from '@shared/types'
import { Wordmark } from '../components/Wordmark'
import { useModeState, useSyncStatus, useUpdateStatus } from '../hooks/usePixl'
import { AccountsSection } from './admin/AccountsSection'
import { DashboardSection } from './admin/DashboardSection'
import { SessionsSection } from './admin/SessionsSection'
import { SettingsSection } from './admin/SettingsSection'
import { TransactionsSection } from './admin/TransactionsSection'
import {
  IconAccounts,
  IconDashboard,
  IconLedger,
  IconLock,
  IconPower,
  IconRefresh,
  IconSessions,
  IconSettings
} from './admin/icons'
import { whenShort } from './admin/AdminUi'
import './admin/admin.css'

// The admin window is a small management app: sidebar navigation on the left,
// one section at a time on the right. `dataVersion` is the single refresh
// signal — every mutation bumps it and every section re-reads what it shows,
// which keeps the dashboard figures honest after a top-up or an adjustment.

type SectionId = 'dashboard' | 'accounts' | 'sessions' | 'transactions' | 'settings'

interface SectionDef {
  id: SectionId
  label: string
  icon: (props: { className?: string }) => JSX.Element
  /** One line of orientation under the page title. */
  blurb: string
}

const SECTIONS: SectionDef[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: IconDashboard,
    blurb: 'Takings, stations and the latest movements at a glance.'
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: IconAccounts,
    blurb: 'Top up credits, correct balances, edit and delete customer accounts.'
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: IconSessions,
    blurb: 'One row per login to logout — time used, spend and how it ended.'
  },
  {
    id: 'transactions',
    label: 'Transactions',
    icon: IconLedger,
    blurb: 'Top-ups and play summaries — not every second tick.'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: IconSettings,
    blurb: 'Pricing, idle shutdown, reminders, and master enable/disable for this PC.'
  }
]

export function AdminPanel(): JSX.Element {
  const mode = useModeState()
  const sync = useSyncStatus()
  const update = useUpdateStatus()
  const [section, setSection] = useState<SectionId>('dashboard')
  const [dataVersion, setDataVersion] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [updating, setUpdating] = useState(false)

  const bump = useCallback(() => setDataVersion((v) => v + 1), [])
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const online = mode?.online ?? false

  async function syncNow(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    try {
      await window.pixl.forceSync()
      bump()
    } finally {
      setSyncing(false)
    }
  }

  async function onUpdateClick(): Promise<void> {
    if (updating || !update || update.phase === 'disabled') return
    setUpdating(true)
    try {
      if (update.phase === 'downloaded') {
        if (
          confirm(
            `Install Pixl ${update.availableVersion ?? ''} now? The app will restart. Active play sessions should be ended first.`
          )
        ) {
          await window.pixl.installUpdate()
        }
      } else {
        await window.pixl.checkForUpdates()
      }
    } finally {
      setUpdating(false)
    }
  }

  function quit(): void {
    if (
      confirm(
        'Quit Pixl for maintenance? The watchdog will stay off until Pixl is started again or the PC restarts.'
      )
    ) {
      void window.pixl.adminQuitApp()
    }
  }

  return (
    <div className="adm-root">
      <div className="adm-fx" aria-hidden="true" />

      <aside className="adm-side">
        <div className="adm-side-brand">
          <Wordmark size="sm" />
          <span className="adm-side-tag">Manager</span>
        </div>

        <nav className="adm-nav" aria-label="Admin sections">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            return (
              <button
                key={s.id}
                type="button"
                className={'adm-nav-item' + (section === s.id ? ' is-active' : '')}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                <Icon />
                <span>{s.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="adm-side-foot">
          <div className="adm-link-row">
            <span className={'badge ' + (online ? 'badge-online' : 'badge-offline')}>
              {online ? 'Online' : 'Offline'}
            </span>
            <button
              className="btn btn-ghost btn-sm adm-sync-btn"
              type="button"
              disabled={syncing}
              onClick={() => void syncNow()}
            >
              {syncing ? <span className="spinner" /> : <IconRefresh />}
              Sync
            </button>
          </div>
          {sync && (
            <dl className="adm-sync-facts">
              <div>
                <dt>Queued</dt>
                <dd className="num">{sync.pendingCount}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd className="num">{sync.lastSyncAt ? whenShort(sync.lastSyncAt) : 'never'}</dd>
              </div>
            </dl>
          )}
          {sync?.lastError && <p className="adm-sync-error">{sync.lastError}</p>}

          <div className="adm-update">
            <div className="adm-update-row">
              <span className="adm-update-ver num">
                v{update?.currentVersion ?? '…'}
              </span>
              <button
                className="btn btn-ghost btn-sm adm-sync-btn"
                type="button"
                disabled={
                  updating ||
                  !update ||
                  update.phase === 'disabled' ||
                  update.phase === 'checking' ||
                  update.phase === 'downloading'
                }
                onClick={() => void onUpdateClick()}
              >
                {updating || updateBusy(update) ? (
                  <span className="spinner" />
                ) : update?.phase === 'downloaded' ? (
                  <IconRefresh />
                ) : (
                  <IconRefresh />
                )}
                {updateButtonLabel(update)}
              </button>
            </div>
            <p className={'adm-update-status' + (update?.phase === 'error' ? ' is-bad' : '')}>
              {updateStatusText(update)}
            </p>
          </div>

          <div className="adm-side-actions">
            <button
              className="btn btn-sm adm-side-btn"
              type="button"
              onClick={() => void window.pixl.adminLogout()}
            >
              <IconLock />
              Lock station
            </button>
            <button className="btn btn-danger btn-sm adm-side-btn" type="button" onClick={quit}>
              <IconPower />
              Quit (maintenance)
            </button>
          </div>
        </div>
      </aside>

      <main className="adm-main">
        <header className="adm-head">
          <div className="adm-head-text">
            <p className="adm-head-eyebrow num">
              {mode?.pc?.name ?? 'this station'} · admin console
            </p>
            <h1 className="adm-head-title">{current.label}</h1>
            <p className="adm-head-sub">{current.blurb}</p>
          </div>
          <button className="btn btn-sm" type="button" onClick={bump}>
            <IconRefresh />
            Refresh
          </button>
        </header>

        <div className="adm-body">
          {section === 'dashboard' && <DashboardSection version={dataVersion} />}
          {section === 'accounts' && (
            <AccountsSection version={dataVersion} onChanged={bump} />
          )}
          {section === 'sessions' && <SessionsSection version={dataVersion} />}
          {section === 'transactions' && <TransactionsSection version={dataVersion} />}
          {section === 'settings' && <SettingsSection onChanged={bump} />}
        </div>
      </main>
    </div>
  )
}

function updateBusy(update: UpdateStatus | null): boolean {
  return update?.phase === 'checking' || update?.phase === 'downloading'
}

function updateButtonLabel(update: UpdateStatus | null): string {
  if (!update || update.phase === 'disabled') return 'Updates N/A'
  if (update.phase === 'checking') return 'Checking…'
  if (update.phase === 'downloading') {
    const pct = update.downloadPercent
    return pct != null ? `Downloading ${pct}%` : 'Downloading…'
  }
  if (update.phase === 'downloaded' || update.phase === 'available') return 'Update now'
  return 'Check for updates'
}

function updateStatusText(update: UpdateStatus | null): string {
  if (!update) return 'Reading version…'
  if (update.message) return update.message
  switch (update.phase) {
    case 'disabled':
      return 'Packaged builds only'
    case 'checking':
      return 'Checking…'
    case 'available':
      return update.availableVersion
        ? `${update.availableVersion} available`
        : 'Update available'
    case 'downloading':
      return 'Downloading…'
    case 'downloaded':
      return 'Ready to install'
    case 'not-available':
      return 'Up to date'
    case 'error':
      return 'Update error'
    default:
      return 'Idle'
  }
}
