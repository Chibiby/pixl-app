import { useEffect, useState, type JSX } from 'react'
import type { AppSettings } from '@shared/types'
import { formatDuration } from '../../hooks/usePixl'
import { type Note, NoteLine, Panel, errText } from './AdminUi'

export function SettingsSection({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [rateMinutes, setRateMinutes] = useState('6')
  const [idleMinutes, setIdleMinutes] = useState('3')
  const [reminders, setReminders] = useState('5, 1')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.pixl
      .getSettings()
      .then((s) => {
        if (!alive) return
        applyToForm(s)
      })
      .catch((e: unknown) => {
        if (alive) setError(errText(e, 'Could not load settings'))
      })
    return () => {
      alive = false
    }
  }, [])

  function applyToForm(s: AppSettings): void {
    setSettings(s)
    setRateMinutes(String(round1(s.pesoToSecondsRate / 60)))
    setIdleMinutes(String(Math.round(s.idleShutdownSeconds / 60)))
    setReminders(s.reminderThresholdsSeconds.map((sec) => round1(sec / 60)).join(', '))
  }

  const parsedReminders = parseThresholds(reminders)
  const rate = Number(rateMinutes)
  const rateValid = Number.isFinite(rate) && rate > 0
  const idle = Number(idleMinutes)
  const idleValid = Number.isFinite(idle) && idle >= 0
  const canSave = rateValid && idleValid && parsedReminders !== null

  async function save(): Promise<void> {
    if (busy || !canSave || parsedReminders === null) return
    setBusy(true)
    setNote(null)
    try {
      const next = await window.pixl.updateSettings({
        pesoToSecondsRate: Math.round(rate * 60),
        idleShutdownSeconds: Math.round(idle * 60),
        reminderThresholdsSeconds: parsedReminders
      })
      applyToForm(next)
      setNote({ tone: 'ok', text: 'Settings saved' })
      onChanged()
    } catch (e) {
      setNote({ tone: 'err', text: errText(e, 'Could not save settings') })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="lock-error">{error}</p>
  if (!settings) return <p className="adm-loading">Loading settings…</p>

  return (
    <div className="adm-stack adm-settings">
      <Panel title="Pricing" meta="applies to every purchase from now on">
        <div className="adm-setting">
          <div className="field">
            <label className="lock-label" htmlFor="set-rate">
              Minutes of play per ₱1
            </label>
            <input
              id="set-rate"
              className="input num"
              type="number"
              min="0.1"
              step="0.1"
              value={rateMinutes}
              onChange={(e) => setRateMinutes(e.target.value)}
            />
            {!rateValid && <p className="adm-hint is-bad">Enter a rate above zero.</p>}
          </div>
          <p className="adm-setting-copy">
            The exchange rate between credits and play time. At{' '}
            <span className="num">{rateValid ? round1(rate) : '—'}</span> min per ₱1, ₱20 buys{' '}
            <span className="num">{rateValid ? formatDuration(rate * 60 * 20) : '—'}</span>. Timed
            sessions convert credits to a temporary countdown at this rate when play starts;
            unused time returns to credits on logout. Open-time sessions burn credits at the same
            rate per second.
          </p>
        </div>
      </Panel>

      <Panel title="Station behaviour" meta={settings.isAdminMachine ? 'admin machine' : undefined}>
        <div className="adm-setting">
          <div className="field">
            <label className="lock-label" htmlFor="set-idle">
              Idle auto-shutdown (minutes, 0 = off)
            </label>
            <input
              id="set-idle"
              className="input num"
              type="number"
              min="0"
              step="1"
              value={idleMinutes}
              disabled={settings.isAdminMachine}
              onChange={(e) => setIdleMinutes(e.target.value)}
            />
            {!idleValid && <p className="adm-hint is-bad">Enter zero or more minutes.</p>}
          </div>
          <p className="adm-setting-copy">
            How long this PC may sit locked with no user logged in before it shuts itself down
            (default 3 minutes).{' '}
            {settings.isAdminMachine
              ? 'Forced off on this machine because it is flagged as the admin station in .env.'
              : 'Set 0 to keep the station awake indefinitely.'}
          </p>
        </div>

        <div className="adm-setting">
          <div className="field">
            <label className="lock-label" htmlFor="set-reminders">
              Reminder thresholds (minutes, comma separated)
            </label>
            <input
              id="set-reminders"
              className="input num"
              type="text"
              placeholder="5, 1"
              value={reminders}
              onChange={(e) => setReminders(e.target.value)}
            />
            {parsedReminders === null ? (
              <p className="adm-hint is-bad">
                Use positive numbers separated by commas, e.g. <span className="num">10, 5, 1</span>.
              </p>
            ) : (
              <p className="adm-hint num">
                Stored as{' '}
                {parsedReminders.length === 0
                  ? 'no reminders'
                  : parsedReminders.map((s) => `${s}s`).join(', ')}
              </p>
            )}
          </div>
          <p className="adm-setting-copy">
            When a session&apos;s remaining runway crosses one of these marks, the customer gets a
            warning so they can buy more time before the screen locks. Leave the field empty to
            disable reminders entirely.
          </p>
        </div>
      </Panel>

      <div className="adm-save-row">
        <button
          className="btn btn-primary"
          type="button"
          disabled={busy || !canSave}
          onClick={() => void save()}
        >
          {busy ? <span className="spinner" /> : 'Save settings'}
        </button>
        <NoteLine note={note} />
      </div>
    </div>
  )
}

/**
 * "10, 5, 1" -> [600, 300, 60], sorted longest-first and de-duplicated. Returns
 * null when the text is not a clean list, so the form can refuse to save.
 * An empty field is valid and means "no reminders".
 */
function parseThresholds(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const minutes = parts.map(Number)
  if (minutes.some((m) => !Number.isFinite(m) || m <= 0)) return null
  const seconds = minutes.map((m) => Math.round(m * 60)).filter((s) => s > 0)
  return [...new Set(seconds)].sort((a, b) => b - a)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
