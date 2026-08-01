import { useEffect, useState, type JSX } from 'react'
import { LockScreen } from './screens/LockScreen'
import { TrayPopover } from './screens/TrayPopover'
import { AdminPanel } from './screens/AdminPanel'

// Which top-level screen to render is chosen by the hash route the main process
// loads into each window: #/lock, #/tray, or #/admin.
type Route = 'lock' | 'tray' | 'admin'

function parseRoute(): { route: Route; role: string } {
  const hash = window.location.hash.replace(/^#\/?/, '') // e.g. "lock?role=primary"
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query ?? '')
  const route = (['lock', 'tray', 'admin'].includes(path) ? path : 'lock') as Route
  return { route, role: params.get('role') ?? 'primary' }
}

export function App(): JSX.Element {
  const [{ route, role }, setRoute] = useState(parseRoute())

  useEffect(() => {
    const onHash = (): void => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  switch (route) {
    case 'tray':
      return <TrayPopover />
    case 'admin':
      return <AdminPanel />
    case 'lock':
    default:
      return <LockScreen role={role === 'secondary' ? 'secondary' : 'primary'} />
  }
}
