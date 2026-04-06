import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ShellBackgroundLayer } from './components/ShellBackgroundLayer'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { RecordingsPage } from './pages/RecordingsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ControlPage } from './pages/ControlPage'

const MeetingPage = lazy(async () => {
  const m = await import('./pages/MeetingPage')
  return { default: m.MeetingPage }
})

const CameraSourcePage = lazy(async () => {
  const m = await import('./pages/CameraSourcePage')
  return { default: m.CameraSourcePage }
})

const LiveWatchPage = lazy(async () => {
  const m = await import('./pages/LiveWatchPage')
  return { default: m.LiveWatchPage }
})

function RouteFallback() {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center px-4 text-sm text-(--nexivo-text-muted)"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <ShellBackgroundLayer />
      <span className="relative z-10 rounded-full border border-(--nexivo-toast-border) bg-(--nexivo-toast-bg) px-5 py-2.5 text-(--nexivo-text) shadow-lg backdrop-blur-xl">
        Loading…
      </span>
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="m/:code" element={<MeetingPage />} />
        <Route path="watch/:code" element={<LiveWatchPage />} />
        <Route path="camera/:token" element={<CameraSourcePage />} />
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="notes" element={<Navigate to="/?panel=notes" replace />} />
          <Route path="recordings" element={<RecordingsPage />} />
          <Route path="control" element={<ControlPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
