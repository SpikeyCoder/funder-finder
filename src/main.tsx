// First: patches Array.prototype.at before the other modules here run. (In a
// build, chunks this entry imports statically run before it, so they mustn't
// call .at while loading; web-vitals only calls it in observer callbacks.)
import './lib/arrayAt.ts'
import './monitoringSetup.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { installTranslateGuard } from './lib/translateGuard.ts'

installTranslateGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
