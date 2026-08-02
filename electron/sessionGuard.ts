import os from 'os'

/**
 * True when this process is clearly not a cafe interactive desktop session
 * (SYSTEM service / Session 0). Packaged Pixl must not create lock windows there.
 */
export function isNonInteractiveSystemSession(): boolean {
  if (process.platform !== 'win32') return false
  let username = ''
  try {
    username = os.userInfo().username || ''
  } catch {
    username = process.env.USERNAME || process.env.USER || ''
  }
  if (/^SYSTEM$/i.test(username)) return true
  // Session 0 services typically report SESSIONNAME=Services
  const sessionName = process.env.SESSIONNAME || ''
  if (/^Services$/i.test(sessionName)) return true
  return false
}

/** Short username / session hint for bootLog. */
export function sessionBootHint(): string {
  let username = '?'
  try {
    username = os.userInfo().username || '?'
  } catch {
    username = process.env.USERNAME || process.env.USER || '?'
  }
  const sessionName = process.env.SESSIONNAME || '?'
  return `user=${username} sessionName=${sessionName}`
}
