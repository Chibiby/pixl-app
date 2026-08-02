import { useState, type ChangeEvent, type JSX } from 'react'

type PasswordInputProps = {
  id?: string
  className?: string
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  autoComplete?: string
  disabled?: boolean
}

function IconEye(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.4 12s3.4-6.4 9.6-6.4S21.6 12 21.6 12s-3.4 6.4-9.6 6.4S2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

function IconEyeOff(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.2 3.2l17.6 17.6" />
      <path d="M9.9 5.5A10.3 10.3 0 0 1 12 5.2c6.2 0 9.6 6.8 9.6 6.8a16.6 16.6 0 0 1-3.5 3.9" />
      <path d="M6.7 6.9C4 8.8 2.4 12 2.4 12s3.4 6.8 9.6 6.8c1.1 0 2.1-.2 3.1-.5" />
      <path d="M9.8 9.8a2.8 2.8 0 0 0 4 4" />
    </svg>
  )
}

export function PasswordInput({
  id,
  className = 'input',
  value,
  onChange,
  placeholder,
  autoComplete,
  disabled
}: PasswordInputProps): JSX.Element {
  const [visible, setVisible] = useState(false)

  return (
    <div className="password-field">
      <input
        id={id}
        className={className}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
        spellCheck={false}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  )
}
