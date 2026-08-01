import { useId, type JSX } from 'react'
import './Wordmark.css'

/**
 * The PIXL brand mark: a rounded frame around a 2x2 pixel cluster, drawn as
 * inline SVG so it ships with the bundle (the kiosk may be offline).
 */
export function PixlMark({ className }: { className?: string }): JSX.Element {
  const gradientId = useId()
  return (
    <svg
      className={'pxl-mark' + (className ? ' ' + className : '')}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6ff6ff" />
          <stop offset="55%" stopColor="#9aa8ff" />
          <stop offset="100%" stopColor="#c47cff" />
        </linearGradient>
      </defs>
      <rect
        x="2.4"
        y="2.4"
        width="35.2"
        height="35.2"
        rx="11"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.4"
      />
      <rect x="11" y="11" width="8" height="8" rx="2.2" fill={`url(#${gradientId})`} />
      <rect
        x="21"
        y="11"
        width="8"
        height="8"
        rx="2.2"
        fill={`url(#${gradientId})`}
        opacity="0.42"
      />
      <rect
        x="11"
        y="21"
        width="8"
        height="8"
        rx="2.2"
        fill={`url(#${gradientId})`}
        opacity="0.42"
      />
      <rect x="21" y="21" width="8" height="8" rx="2.2" fill={`url(#${gradientId})`} />
    </svg>
  )
}

interface WordmarkProps {
  /** Visual scale: 'lg' for the fullscreen lock hero, 'sm' for compact chrome. */
  size?: 'sm' | 'md' | 'lg'
  /** Small caps line under the word, e.g. "Pisonet Station". */
  tagline?: string
}

/** Brand mark + "PIXL" wordmark with a blinking terminal block. */
export function Wordmark({ size = 'md', tagline }: WordmarkProps): JSX.Element {
  return (
    <div className={`pxl-wm pxl-wm-${size}`}>
      <PixlMark />
      <div className="pxl-wm-text">
        <div className="pxl-wm-word">
          <span className="pxl-wm-letters">PIXL</span>
          <span className="pxl-wm-caret" aria-hidden="true" />
        </div>
        {tagline && <div className="pxl-wm-tag">{tagline}</div>}
      </div>
    </div>
  )
}
