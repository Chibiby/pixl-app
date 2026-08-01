import { useEffect, useState, type FormEvent, type JSX } from 'react'
import type { AccountPublic, LoginResult, SessionMode } from '@shared/types'
import { BUY_TIME_PRESET_CENTAVOS, NO_CREDITS_MESSAGE } from '@shared/money'
import {
  useModeState,
  usePesoRate,
  centavosToMinutes,
  formatDuration,
  formatPesos,
  pesosToCentavos
} from '../hooks/usePixl'
import { Wordmark } from '../components/Wordmark'
import './LockScreen.css'

/** Local needs_time auto-lock (pendingResume uses ModeState.chooserDeadlineAt). */
const CHOOSER_TIMEOUT_MS = 120_000
const CHOOSER_TIMEOUT_MESSAGE = 'Timed out — sign in again to continue'

function formatAutoLock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `Auto lock in ${m}m ${sec}s`
}

interface Props {
  role: 'primary' | 'secondary'
}

const MODE_COPY: Record<SessionMode, { name: string; tag: string; desc: string }> = {
  timed: {
    name: 'Timed',
    tag: 'Countdown',
    desc: 'Play down the time you already bought. The clock stops when time runs out.'
  },
  open: {
    name: 'Open Time',
    tag: 'Pay as you go',
    desc: 'Play straight from your credits. Stop whenever you like — you only pay for what you use.'
  }
}

export function LockScreen({ role }: Props): JSX.Element {
  const mode = useModeState()
  const rate = usePesoRate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [sessionMode, setSessionMode] = useState<SessionMode>('timed')
  const [error, setError] = useState<string | null>(null)
  // Set when a timed login needs time bought first; offers the presets inline.
  const [needsTime, setNeedsTime] = useState(false)
  const [needsTimeAccount, setNeedsTimeAccount] = useState<AccountPublic | null>(null)
  const [customPesos, setCustomPesos] = useState('')
  const [busy, setBusy] = useState(false)
  /** Epoch ms for post-login needs_time countdown. */
  const [localChooserDeadlineAt, setLocalChooserDeadlineAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const pending = mode?.pendingResume ?? null
  const banner = mode?.message ?? null
  const bannerWarns =
    banner !== null && /no credits|used up|ran out|expired|top up|choose time|timed out/i.test(banner)
  const online = mode?.online ?? false
  const pcName = mode?.pc?.name ?? ''
  const minutesPerPeso = centavosToMinutes(100, rate)

  const resumeAccount = pending?.account ?? null
  const buyAccount = resumeAccount ?? needsTimeAccount
  const buyCredits = buyAccount?.credits_centavos ?? 0
  const customCentavos = pesosToCentavos(Number(customPesos))
  const customValid = customCentavos > 0 && customCentavos <= buyCredits
  // Buy chips only on timed paths: pending open→timed resume, or needs_time after timed login.
  const showBuyPanel = Boolean(pending) || (needsTime && sessionMode === 'timed')

  // pendingResume: main-process deadline. needs_time: local 120s deadline.
  const chooserDeadlineAt = pending
    ? (mode?.chooserDeadlineAt ?? null)
    : localChooserDeadlineAt
  const chooserSecondsLeft =
    chooserDeadlineAt != null ? Math.max(0, Math.ceil((chooserDeadlineAt - now) / 1000)) : null

  function clearNeedsTimeHandoff(message: string | null): void {
    setNeedsTime(false)
    setNeedsTimeAccount(null)
    setCustomPesos('')
    setPassword('')
    setLocalChooserDeadlineAt(null)
    setError(message)
  }

  // Timed chooser with 0 credits → immediate clean lockscreen.
  useEffect(() => {
    if (pending && resumeAccount && resumeAccount.credits_centavos <= 0) {
      setError(NO_CREDITS_MESSAGE)
      void window.pixl.cancelPendingResume()
      return
    }
    if (!needsTime || !needsTimeAccount) return
    if (needsTimeAccount.credits_centavos > 0) return
    clearNeedsTimeHandoff(NO_CREDITS_MESSAGE)
    void window.pixl.cancelPendingResume()
  }, [pending, resumeAccount, needsTime, needsTimeAccount])

  // Start / clear local countdown for needs_time (not pendingResume).
  useEffect(() => {
    if (pending) {
      setLocalChooserDeadlineAt(null)
      return
    }
    if (needsTime && needsTimeAccount && needsTimeAccount.credits_centavos > 0) {
      setLocalChooserDeadlineAt((prev) => prev ?? Date.now() + CHOOSER_TIMEOUT_MS)
      return
    }
    setLocalChooserDeadlineAt(null)
  }, [pending, needsTime, needsTimeAccount])

  // Tick countdown; on local needs_time expiry clear handoff.
  useEffect(() => {
    if (chooserDeadlineAt == null) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t < chooserDeadlineAt) return
      if (pending) return // main cancelPendingResume owns pendingResume timeout
      clearNeedsTimeHandoff(CHOOSER_TIMEOUT_MESSAGE)
      void window.pixl.cancelPendingResume()
    }, 250)
    return () => window.clearInterval(id)
  }, [chooserDeadlineAt, pending])

  async function signIn(purchaseCentavos = 0): Promise<void> {
    if (busy || !username || !password) return
    setBusy(true)
    setError(null)
    try {
      const res: LoginResult = await window.pixl.login(
        username.trim(),
        password,
        sessionMode,
        purchaseCentavos
      )
      if (res.outcome === 'ok' || res.outcome === 'admin_ok') {
        // Buy succeeded / session started — drop local chooser countdown.
        clearNeedsTimeHandoff(null)
      } else if (res.outcome === 'no_credits') {
        // Block entry: clear buy panel + password; keep username for retry after top-up.
        clearNeedsTimeHandoff(res.message)
      } else if (res.outcome === 'needs_time') {
        // Keep the password so a preset can retry the same sign-in.
        // Empty message is expected — chooser banner covers zero-time login.
        setNeedsTime(true)
        setNeedsTimeAccount(res.account)
        setError(res.message ? res.message : null)
      } else if (purchaseCentavos > 0 && res.outcome === 'error') {
        // A failed buy-and-start (e.g. not enough credits for that preset)
        // keeps the panel and password so another amount can be tried.
        if (res.account) {
          if (res.account.credits_centavos <= 0) {
            clearNeedsTimeHandoff(NO_CREDITS_MESSAGE)
          } else {
            setNeedsTimeAccount(res.account)
            setError(res.message)
          }
        } else {
          setError(res.message)
        }
      } else {
        clearNeedsTimeHandoff(res.message)
      }
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function onResume(purchaseCentavos = 0): Promise<void> {
    if (busy || !pending) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.pixl.resumeTimed(purchaseCentavos)
      if (res.outcome === 'ok') {
        setCustomPesos('')
        setError(null)
      } else if (res.outcome === 'no_credits') {
        setCustomPesos('')
        setError(res.message || NO_CREDITS_MESSAGE)
      } else if (res.outcome === 'needs_time') {
        // Empty message is expected — chooser banner covers zero-time resume.
        setError(res.message ? res.message : null)
      } else {
        setError(res.message)
      }
    } catch {
      setError('Could not start timed session. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function onCancelResume(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.pixl.cancelPendingResume()
      setCustomPesos('')
    } catch {
      setError('Could not cancel. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    await signIn()
  }

  function pickMode(next: SessionMode): void {
    setSessionMode(next)
    setNeedsTime(false)
    setNeedsTimeAccount(null)
    setLocalChooserDeadlineAt(null)
    setError(null)
  }

  const backdrop = (
    <div className="lock-fx" aria-hidden="true">
      <span className="lock-fx-aurora" />
      <span className="lock-fx-grid" />
      <span className="lock-fx-scan" />
      <span className="lock-fx-vignette" />
    </div>
  )

  const link = (
    <span className={'lock-link ' + (online ? 'is-online' : 'is-offline')}>
      <span className="lock-link-dot" />
      {online ? 'Server linked' : 'Offline mode'}
    </span>
  )

  if (role === 'secondary') {
    return (
      <div className="lock-root lock-root-secondary">
        {backdrop}
        <div className="lock-secondary">
          <Wordmark size="md" tagline="Pisonet Station" />
          <div className="lock-plate">
            <svg className="lock-plate-glyph" viewBox="0 0 24 24" aria-hidden="true">
              <rect
                x="4.5"
                y="10.5"
                width="15"
                height="10"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
            </svg>
            <h1 className="lock-plate-title">Screen locked</h1>
            <p className="lock-plate-sub">Sign in on the main monitor to start a session.</p>
          </div>
          <div className="lock-secondary-foot">
            {pcName && <span className="num">{pcName}</span>}
            {link}
          </div>
        </div>
      </div>
    )
  }

  const buyPanel = showBuyPanel && buyAccount && (
    <section className="lock-buy" aria-labelledby="lock-buy-title">
      <div className="lock-buy-head">
        <h3 className="lock-buy-title" id="lock-buy-title">
          {pending ? 'Choose time to continue' : 'Buy time & start'}
        </h3>
        <span className="lock-buy-note">charged to your credits</span>
      </div>

      <div className="lock-buy-balance">
        <span className="lock-buy-balance-label">Credits available</span>
        <span className="lock-buy-balance-value num">{formatPesos(buyCredits)}</span>
      </div>

      {chooserSecondsLeft != null && (
        <p className="lock-chooser-countdown num" aria-live="polite">
          {formatAutoLock(chooserSecondsLeft)}
        </p>
      )}

      <div className="lock-buy-grid">
        {BUY_TIME_PRESET_CENTAVOS.map((centavos) => (
          <button
            key={centavos}
            type="button"
            className="buy-chip"
            disabled={busy || buyCredits < centavos}
            onClick={() => void (pending ? onResume(centavos) : signIn(centavos))}
          >
            <span className="buy-chip-peso num">{formatPesos(centavos)}</span>
            <span className="buy-chip-min">{centavosToMinutes(centavos, rate)} min</span>
          </button>
        ))}
      </div>

      <div className="lock-buy-custom">
        <label className="lock-label" htmlFor="lock-custom-amount">
          Or another amount
        </label>
        <div className="lock-buy-row">
          <div className="amount">
            <span className="amount-peso" aria-hidden="true">
              ₱
            </span>
            <input
              id="lock-custom-amount"
              className="input amount-input"
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
                if (!customValid) return
                void (pending ? onResume(customCentavos) : signIn(customCentavos))
              }}
              placeholder="20"
            />
          </div>
          <button
            type="button"
            className="btn btn-primary lock-buy-go"
            disabled={busy || !customValid}
            onClick={() => void (pending ? onResume(customCentavos) : signIn(customCentavos))}
          >
            {pending ? 'Buy & continue' : 'Buy & start'}
          </button>
        </div>
        <p className="lock-buy-preview" aria-live="polite">
          {customCentavos <= 0
            ? 'Enter pesos to see the minutes you get'
            : customCentavos > buyCredits
              ? 'More than your credits'
              : `${formatPesos(customCentavos)} · ${centavosToMinutes(customCentavos, rate)} min of play`}
        </p>
      </div>
    </section>
  )

  // Open→timed handoff: identity is already known; only choose time (no password).
  if (pending && resumeAccount) {
    const displayName = resumeAccount.display_name || resumeAccount.username
    return (
      <div className="lock-root">
        {backdrop}

        <main className="lock-stage">
          <section className="lock-hero">
            <Wordmark size="lg" tagline="Pisonet Station" />
            <h1 className="lock-hero-line">
              Almost there.
              <br />
              <span className="lock-hero-accent">Pick your time.</span>
            </h1>
            <p className="lock-hero-copy">
              You switched from open time. Buy a block with your credits to start a timed session —
              no password needed.
            </p>

            <dl className="lock-specs">
              <div className="lock-spec">
                <dt>Player</dt>
                <dd>{displayName}</dd>
              </div>
              <div className="lock-spec">
                <dt>Credits</dt>
                <dd className="num">{formatPesos(resumeAccount.credits_centavos)}</dd>
              </div>
              <div className="lock-spec">
                <dt>Rate</dt>
                <dd className="num">
                  ₱1 <span className="lock-spec-eq">≈</span> {minutesPerPeso} min
                </dd>
              </div>
            </dl>
          </section>

          <div className="lock-card" aria-busy={busy}>
            <div className="lock-card-rail" aria-hidden="true" />
            <header className="lock-card-head">
              <h2 className="lock-card-title">Continue timed</h2>
              <p className="lock-card-sub">
                Signed in as <span className="num">@{resumeAccount.username}</span>
              </p>
            </header>

            {banner && (
              <div className={'lock-banner ' + (bannerWarns ? 'is-warn' : 'is-info')}>{banner}</div>
            )}

            {error && (
              <div className="lock-error" role="alert">
                {error}
              </div>
            )}

            {resumeAccount.time_balance_seconds > 0 && (
              <button
                className="btn btn-primary lock-submit"
                type="button"
                disabled={busy}
                onClick={() => void onResume(0)}
              >
                Continue with {formatDuration(resumeAccount.time_balance_seconds)} left
              </button>
            )}

            {buyPanel}

            <button
              className="btn btn-ghost lock-cancel-resume"
              type="button"
              disabled={busy}
              onClick={() => void onCancelResume()}
            >
              Cancel — stay locked
            </button>
            <p className="lock-hint">
              Cancel clears the switch and returns you to the lock screen. Sign in again to go back
              to open time.
            </p>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="lock-root">
      {backdrop}

      <main className="lock-stage">
        <section className="lock-hero">
          <Wordmark size="lg" tagline="Pisonet Station" />
          <h1 className="lock-hero-line">
            Take the seat.
            <br />
            <span className="lock-hero-accent">Start your run.</span>
          </h1>
          <p className="lock-hero-copy">
            Sign in to unlock this station. Buy time up front or pay as you play — your credits work
            either way.
          </p>

          <dl className="lock-specs">
            <div className="lock-spec">
              <dt>Station</dt>
              <dd className="num">{pcName || 'Unnamed PC'}</dd>
            </div>
            <div className="lock-spec">
              <dt>Link</dt>
              <dd>{link}</dd>
            </div>
            <div className="lock-spec">
              <dt>Rate</dt>
              <dd className="num">
                ₱1 <span className="lock-spec-eq">≈</span> {minutesPerPeso} min
              </dd>
            </div>
          </dl>
        </section>

        <form className="lock-card" onSubmit={onSubmit} aria-busy={busy}>
          <div className="lock-card-rail" aria-hidden="true" />
          <header className="lock-card-head">
            <h2 className="lock-card-title">Sign in</h2>
            <p className="lock-card-sub">Use the account from the counter</p>
          </header>

          {banner && (
            <div className={'lock-banner ' + (bannerWarns ? 'is-warn' : 'is-info')}>{banner}</div>
          )}

          <div className="field">
            <label className="lock-label" htmlFor="lock-username">
              Username
            </label>
            <input
              id="lock-username"
              className="input"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your username"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label className="lock-label" htmlFor="lock-password">
              Password
            </label>
            <input
              id="lock-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="off"
            />
          </div>

          <fieldset className="lock-modes">
            <legend className="lock-label lock-modes-legend">Session type</legend>
            <div className="lock-mode-grid">
              {(['timed', 'open'] as SessionMode[]).map((value) => (
                <label key={value} className="mode">
                  <input
                    className="mode-radio"
                    type="radio"
                    name="lock-session-mode"
                    value={value}
                    checked={sessionMode === value}
                    onChange={() => pickMode(value)}
                  />
                  <span className="mode-body">
                    <span className="mode-top">
                      <span className="mode-name">{MODE_COPY[value].name}</span>
                      <span className="mode-check" aria-hidden="true" />
                    </span>
                    <span className="mode-tag">{MODE_COPY[value].tag}</span>
                    <span className="mode-desc">{MODE_COPY[value].desc}</span>
                    <span className={'mode-foot' + (value === 'open' ? ' num' : '')}>
                      {value === 'timed'
                        ? 'Counts down purchased time'
                        : `₱1 ≈ ${minutesPerPeso} min`}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <div
              className={
                /no credits|top up/i.test(error) ? 'lock-banner is-warn' : 'lock-error'
              }
              role="alert"
            >
              {error}
            </div>
          )}

          {buyPanel}

          <button
            className="btn btn-primary lock-submit"
            disabled={busy || !username || !password}
            type="submit"
          >
            {busy ? (
              <>
                <span className="spinner" />
                Checking…
              </>
            ) : (
              'Start session'
            )}
          </button>

          <p className="lock-hint">Out of credits? Top up at the counter.</p>
        </form>
      </main>
    </div>
  )
}
