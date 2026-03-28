import { Navigate, Route, Routes } from 'react-router-dom'
import { AgeVerificationGate } from './components/AgeVerificationGate'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { MeetingPage } from './pages/MeetingPage'
import { CameraSourcePage } from './pages/CameraSourcePage'
import { RecordingsPage } from './pages/RecordingsPage'

export default function App() {
  return (
    <AgeVerificationGate>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="m/:code" element={<MeetingPage />} />
        <Route path="camera/:token" element={<CameraSourcePage />} />
        <Route element={<Layout />}>
          <Route path="recordings" element={<RecordingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AgeVerificationGate>
  )
}
