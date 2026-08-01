import type { JSX } from 'react'

// Inline SVG icons for the admin chrome. Drawn on a 24x24 grid with
// currentColor strokes so nav items and buttons tint them for free, and so the
// panel needs no icon font or network asset.

type IconProps = { className?: string }

function frame(className: string | undefined, path: JSX.Element): JSX.Element {
  return (
    <svg
      className={'adm-icon' + (className ? ' ' + className : '')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  )
}

export function IconDashboard({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <rect x="3" y="3" width="7.5" height="8.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="2" />
      <rect x="3" y="14.5" width="7.5" height="6.5" rx="2" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="2" />
    </>
  )
}

export function IconAccounts({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.8 20.2c0-3.2 2.8-5.4 6.2-5.4s6.2 2.2 6.2 5.4" />
      <path d="M16.4 5.2a3.2 3.2 0 0 1 0 6.1" />
      <path d="M18.2 14.6c1.8.7 3 2.2 3 4.1" />
    </>
  )
}

export function IconSessions({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 7.2V12l3.4 2.1" />
    </>
  )
}

export function IconLedger({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <path d="M5 3.4h11.2L20 7v13.6H5z" />
      <path d="M8.4 9.6h7.2M8.4 13.2h7.2M8.4 16.8h4.4" />
    </>
  )
}

export function IconSettings({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <circle cx="12" cy="12" r="2.9" />
      <path d="M12 2.8v2.6M12 18.6v2.6M4.5 12H2M22 12h-2.5M6.7 6.7 4.9 4.9M19.1 19.1l-1.8-1.8M17.3 6.7l1.8-1.8M4.9 19.1l1.8-1.8" />
    </>
  )
}

export function IconRefresh({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.4 3.6V8h-4.5" />
    </>
  )
}

export function IconLock({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <rect x="4.6" y="10.4" width="14.8" height="10.2" rx="2.6" />
      <path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6" />
    </>
  )
}

export function IconPower({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <path d="M12 3.2v7.4" />
      <path d="M6.9 6.6a7.6 7.6 0 1 0 10.2 0" />
    </>
  )
}

export function IconClose({ className }: IconProps): JSX.Element {
  return frame(className, <path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />)
}

export function IconSearch({ className }: IconProps): JSX.Element {
  return frame(
    className,
    <>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="M15.6 15.6 20.4 20.4" />
    </>
  )
}

export function IconPlus({ className }: IconProps): JSX.Element {
  return frame(className, <path d="M12 5.2v13.6M5.2 12h13.6" />)
}
