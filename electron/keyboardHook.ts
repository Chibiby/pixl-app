// Low-level keyboard hardening while the lockscreen is up. Uses
// node-global-key-listener (which installs a Windows low-level keyboard hook) to
// swallow escape-hatch combos: Win, Alt+Tab, Ctrl+Shift+Esc, Ctrl+Esc.
//
// NOTE: Ctrl+Alt+Del (the Secure Attention Sequence) cannot be intercepted from
// user mode by design; that requires GPO/registry lockdown (see the README).

type KeyName = string

let listener: unknown = null
let active = false
let attached = false

// A key event proxy shape compatible with node-global-key-listener.
interface GkEvent {
  name?: string
  state?: 'DOWN' | 'UP'
}
type GkDown = Record<string, boolean>

function shouldSwallow(e: GkEvent, down: GkDown): boolean {
  if (!active) return false
  const name = (e.name ?? '').toUpperCase()

  const win = down['LEFT META'] || down['RIGHT META']
  const alt = down['LEFT ALT'] || down['RIGHT ALT']
  const ctrl = down['LEFT CTRL'] || down['RIGHT CTRL']
  const shift = down['LEFT SHIFT'] || down['RIGHT SHIFT']

  // Windows key (either physical Meta press)
  if (name === 'LEFT META' || name === 'RIGHT META') return true
  // Alt+Tab
  if (alt && name === 'TAB') return true
  // Ctrl+Esc (opens Start)
  if (ctrl && name === 'ESCAPE') return true
  // Ctrl+Shift+Esc (Task Manager)
  if (ctrl && shift && name === 'ESCAPE') return true
  // Alt+F4 (also blocked at the window level, belt-and-suspenders)
  if (alt && name === 'F4') return true

  return false
}

export function initKeyboardHook(): void {
  if (attached) return
  try {
    // Lazy require so the app still runs if the native hook is unavailable.

    const { GlobalKeyboardListener } = require('node-global-key-listener')
    const gkl = new GlobalKeyboardListener()
    listener = gkl
    const handler = (e: GkEvent, down: GkDown): boolean => {
      if (e.state !== 'DOWN') return false
      // Returning true tells the library to consume/suppress the key.
      return shouldSwallow(e, down)
    }
    // start() spawns a native helper process which can fail on some machines
    // (blocked exe, AV, no interactive session). Catch it so the kiosk keeps
    // running without native key suppression rather than crashing.
    Promise.resolve(gkl.start())
      .then(() => {
        gkl.addListener(handler)
        attached = true
      })
      .catch((err: unknown) => {
        console.warn('[keyboardHook] native key server unavailable:', err)
        attached = false
      })
  } catch (err) {
    // Non-fatal: kiosk still works, just without native key suppression.

    console.warn('[keyboardHook] native key listener unavailable:', err)
  }
}

export function setKeyboardHookActive(on: boolean): void {
  active = on
}

export function disposeKeyboardHook(): void {
  try {
    const l = listener as { kill?: () => void } | null
    l?.kill?.()
  } catch {
    /* ignore */
  }
  listener = null
  attached = false
  active = false
}
