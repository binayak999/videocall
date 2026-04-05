import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { fetchSystemRtcMode } from '../lib/api'
import { AUTH_CHANGE_EVENT } from '../lib/auth'
import { setServerRtcDefault, type RtcMode } from '../lib/rtcMode'
import { LayoutAppContext } from './LayoutAppContext'
import { NexivoAppShell } from './NexivoAppShell'
import { NexivoSidebarNav } from './NexivoSidebarNav'

export type NexivoOutletContext = {
  selectedFeature: string | null
  setSelectedFeature: (v: string | null) => void
  /** False until the first GET /api/system/rtc-mode attempt finishes (success or failure). */
  systemRtcLoaded: boolean
  systemRtcMode: RtcMode | null
  /** Global default is stored in Postgres (`SystemSetting`), not inferred from env only. */
  systemRtcPersisted: boolean
  canControlRtcMode: boolean
  refreshSystemRtcMode: () => Promise<void>
}

export function Layout() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const [systemRtcLoaded, setSystemRtcLoaded] = useState(false)
  const [systemRtcMode, setSystemRtcMode] = useState<RtcMode | null>(null)
  const [systemRtcPersisted, setSystemRtcPersisted] = useState(false)
  const [canControlRtcMode, setCanControlRtcMode] = useState(false)

  const refreshSystemRtcMode = useCallback(async () => {
    try {
      const r = await fetchSystemRtcMode()
      setServerRtcDefault(r.rtcMode)
      setSystemRtcMode(r.rtcMode)
      setSystemRtcPersisted(r.persisted)
      setCanControlRtcMode(r.canControl)
    } catch {
      setServerRtcDefault(null)
      setSystemRtcMode(null)
      setSystemRtcPersisted(false)
      setCanControlRtcMode(false)
    } finally {
      setSystemRtcLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refreshSystemRtcMode()
    const onAuth = () => void refreshSystemRtcMode()
    window.addEventListener(AUTH_CHANGE_EVENT, onAuth)
    return () => window.removeEventListener(AUTH_CHANGE_EVENT, onAuth)
  }, [refreshSystemRtcMode])

  const outletContext = {
    selectedFeature,
    setSelectedFeature,
    systemRtcLoaded,
    systemRtcMode,
    systemRtcPersisted,
    canControlRtcMode,
    refreshSystemRtcMode,
  } satisfies NexivoOutletContext

  const layoutAppValue = useMemo(
    () => ({ systemRtcLoaded, canControlRtcMode }),
    [systemRtcLoaded, canControlRtcMode],
  )

  return (
    <LayoutAppContext.Provider value={layoutAppValue}>
      <NexivoAppShell
        sidebar={<NexivoSidebarNav />}
        selectedFeature={selectedFeature}
        onToggleFeature={setSelectedFeature}
      >
        <Outlet context={outletContext} />
      </NexivoAppShell>
    </LayoutAppContext.Provider>
  )
}
