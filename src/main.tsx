import React from 'react'
import ReactDOM from 'react-dom/client'
// Design tokens and primitives load before the screens so per-screen rules can
// override them at equal specificity.
import './styles/global.css'
import { App } from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
