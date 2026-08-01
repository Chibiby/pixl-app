import { useState, type JSX } from 'react'
import type { SessionMode } from '@shared/types'
import { BUY_TIME_PRESET_CENTAVOS } from '@shared/money'
import {
  useModeState,
  useSessionTick,
  usePesoRate,
  centavosToMinutes,
  formatDuration,
  formatPesos,
  pesosToCentavos
} from '../hooks/usePixl'
import { PixlMark } from '../components/Wordmark'
import './TrayPopover.css'

/** Runway at or below this is treated as "about to run out". */
const LOW_SECONDS = 300

interface Chunk {
  value: string
  unit: string
}

/**
 * Splits a duration into the same units `formatDuration` picks, so the hero
 * readout can render big numerals with small unit suffixes.
 */
function durationChunks(totalSeconds: number): Chunk[] {
  const total = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (hours > 0) return [{ value: String(hours), unit: 'h' }, { value: pad(minutes), unit: 'm' }]
  if (minutes > 0) return [{ value: String(minutes), unit: 'm' }, { value: pad(seconds), unit: 's' }]
  return [{ value: String(seconds), unit: 's' }]
}

export function TrayPopover(): JSX.Element {
  const mode = useModeState()
  const snap = useSessionTick(mode?.session ?? null)
  const rate = usePesoRate()
  const online = mode?.online ?? false
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [customPesos, setCustomPesos] = useState('')
  const [busy, setBusy] = useState(false)

  const displayName = snap?.displayName ?? mode?.account?.display_name ?? 'Guest'
  const username = snap?.username ?? mode?.account?.username ?? ''
  const sessionMode = snap?.mode ?? 'timed'
  const timeLeft = snap?.secondsRemaining ?? 0
  const credits = snap?.creditsCentavos ?? mode?.account?.credits_centavos ?? 0
  const spent = snap?.spentCentavos ?? 0
  const used = snap?.secondsUsedThisSession ?? 0

  const low = timeLeft <= LOW_SECONDS
  const timed = sessionMode === 'timed'
  // Share of the session's starting budget still unspent — time for timed
  // sessions, money for open time.
  const budget = timed ? timeLeft + used : credits + spent
  const left = timed ? timeLeft : credits
  const leftPct = budget > 0 ? Math.min(100, Math.max(0, (left / budget) * 100)) : 0

  const customCentavos = pesosToCentavos(Number(customPesos))
  const customValid = customCentavos > 0 && customCentavos <= credits

  // One line under the use row: last result, or a live preview of minutes.
  const useHint =
    customCentavos <= 0
      ? 'Credits convert into timed session minutes'
      : customCentavos > credits
        ? 'More than your credits'
        : `${formatPesos(customCentavos)} → ${centavosToMinutes(customCentavos, rate)} min of play`
  const message = note?.text ?? (timed ? useHint : '')
  const messageTone = note ? (note.tone === 'ok' ? 'is-ok' : 'is-err') : 'is-hint'
  const useLabel =
    customValid && customCentavos > 0 ? `Use ${formatPesos(customCentavos)}` : 'Use'

  async function onLogout(): Promise<void> {
    await window.pixl.logout('logout')
  }

  async function buy(centavos: number): Promise<void> {
    if (busy || centavos <= 0 || !timed) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.pixl.buyTime({ centavos })
      if (res.outcome === 'ok') {
        setNote({ tone: 'ok', text: `Added ${formatDuration(res.addedSeconds)} of play` })
        setCustomPesos('')
      } else {
        setNote({ tone: 'err', text: res.message })
      }
    } catch {
      setNote({ tone: 'err', text: 'Could not buy time. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  async function onSwitchMode(next: SessionMode): Promise<void> {
    if (busy || next === sessionMode) return
    setBusy(true)
    setNote(null)
    try {
      const res = await window.pixl.switchMode(next)
      if (res.outcome === 'ok') {
        // open→timed usually parks on the lockscreen; timed→open stays in-session.
        setNote({
          tone: 'ok',
          text: next === 'open' ? 'Switched to open time' : 'Choose time to continue'
        })
      } else {
        setNote({ tone: 'err', text: res.message || 'Could not switch mode.' })
      }
    } catch {
      setNote({ tone: 'err', text: 'Could not switch mode. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  const initial = (displayName.trim() || username || '?').charAt(0).toUpperCase()

  return (
    <div className="hud-root">
      <div className="hud-fx" aria-hidden="true" />

      <header className="hud-head">
        <div className="hud-id">
          <span className="hud-avatar">
            <span className="hud-avatar-initial">{initial}</span>
          </span>
          <span className="hud-id-text">
            <span className="hud-name">{displayName}</span>
            <span className="hud-user num">{username ? '@' + username : 'not signed in'}</span>
          </span>
        </div>
        <span className={'hud-link ' + (online ? 'is-online' : 'is-offline')}>
          <span className="hud-link-dot" />
          {online ? 'Online' : 'Offline'}
        </span>
      </header>

      <div className="hud-body">
        <section className={'hud-hero' + (low ? ' is-low' : '')}>
          <div className="hud-hero-top">
            <span className="hud-hero-label">{timed ? 'Time remaining' : 'Credits'}</span>
            <span className="hud-chip">{timed ? 'Timed' : 'Open time'}</span>
          </div>

          {timed ? (
            <div className="hud-hero-value num">
              {durationChunks(timeLeft).map((chunk) => (
                <span className="hud-hero-part" key={chunk.unit}>
                  {chunk.value}
                  <span className="hud-hero-unit">{chunk.unit}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="hud-hero-value num">
              <span className="hud-hero-part">{formatPesos(credits)}</span>
            </div>
          )}

          <div className="hud-bar">
            <span className="hud-bar-fill" style={{ width: `${leftPct}%` }} />
          </div>

          <p className="hud-hero-foot">
            {timed
              ? low
                ? 'Running low — buy more below'
                : 'Counting down purchased time'
              : `Lasts about ${formatDuration(timeLeft)}`}
          </p>
        </section>

        <fieldset className="hud-mode-switch">
          <legend className="sr-only">Session mode</legend>
          <div className="hud-mode-grid" role="group" aria-label="Session mode">
            {(['timed', 'open'] as SessionMode[]).map((value) => (
              <button
                key={value}
                type="button"
                className={'hud-mode-btn' + (sessionMode === value ? ' is-active' : '')}
                disabled={busy || sessionMode === value}
                aria-pressed={sessionMode === value}
                onClick={() => void onSwitchMode(value)}
              >
                {value === 'timed' ? 'Timed' : 'Open'}
              </button>
            ))}
          </div>
          <p className="hud-mode-hint">
            {timed
              ? 'Switch to Open to play from credits'
              : 'Switch to Timed to buy a block of time'}
          </p>
        </fieldset>

        <dl className="hud-stats">
          <div className="hud-stat">
            <dt>Used this session</dt>
            <dd className="num">{formatDuration(used)}</dd>
          </div>
          <div className="hud-stat">
            <dt>{timed ? 'Credits' : 'Spent'}</dt>
            <dd className="num">{formatPesos(timed ? credits : spent)}</dd>
          </div>
        </dl>

        {timed && (
          <section className="hud-buy" aria-labelledby="hud-buy-title">
            <div className="hud-section-head">
              <h2 className="hud-section-title" id="hud-buy-title">
                Time to use
              </h2>
              <span className="hud-section-meta num">₱1 ≈ {centavosToMinutes(100, rate)} min</span>
            </div>

            <p className="hud-buy-copy">Credits → play time for this timed session</p>

            <div className="hud-buy-balance">
              <span className="hud-buy-balance-label">Credits available</span>
              <span className="hud-buy-balance-value num">{formatPesos(credits)}</span>
            </div>

            <div className="hud-buy-grid" role="group" aria-label="Time presets">
              {BUY_TIME_PRESET_CENTAVOS.map((centavos) => (
                <button
                  key={centavos}
                  type="button"
                  className="buy-chip"
                  disabled={busy || credits < centavos}
                  onClick={() => void buy(centavos)}
                  title={`Use ${formatPesos(centavos)} for ${centavosToMinutes(centavos, rate)} min`}
                >
                  <span className="buy-chip-peso num">Use {formatPesos(centavos)}</span>
                  <span className="buy-chip-min">{centavosToMinutes(centavos, rate)} min</span>
                </button>
              ))}
            </div>

            <div className="hud-buy-custom">
              <label className="hud-buy-custom-label" htmlFor="hud-custom-amount">
                Or another amount
              </label>
              <div className="hud-buy-row">
                <div className="amount">
                  <span className="amount-peso" aria-hidden="true">
                    ₱
                  </span>
                  <input
                    id="hud-custom-amount"
                    className="input input-sm amount-input"
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="1"
                    max="5000"
                    value={customPesos}
                    onChange={(e) => setCustomPesos(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      if (customValid) void buy(customCentavos)
                    }}
                    placeholder="20"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm hud-buy-go"
                  disabled={busy || !customValid}
                  onClick={() => void buy(customCentavos)}
                >
                  {useLabel}
                </button>
              </div>
            </div>

            <p className={'hud-msg ' + messageTone} aria-live="polite">
              {message}
            </p>
          </section>
        )}

        {!timed && note && (
          <p className={'hud-msg ' + messageTone} aria-live="polite">
            {message}
          </p>
        )}
      </div>

      <button className="btn btn-danger hud-logout" type="button" onClick={() => void onLogout()}>
        End session &amp; lock
      </button>

      <div className="hud-brand" aria-hidden="true">
        <PixlMark className="hud-brand-mark" />
        <span className="hud-brand-word">PIXL</span>
      </div>
    </div>
  )
}
