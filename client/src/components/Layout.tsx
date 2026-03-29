import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { NexivoAppShell } from './NexivoAppShell'
import { NexivoSidebarNav } from './NexivoSidebarNav'

export type NexivoOutletContext = {
  selectedFeature: string | null
  setSelectedFeature: (v: string | null) => void
}

export function Layout() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)

  return (
    <NexivoAppShell
      sidebar={<NexivoSidebarNav />}
      selectedFeature={selectedFeature}
      onToggleFeature={setSelectedFeature}
    >
      <Outlet context={{ selectedFeature, setSelectedFeature } satisfies NexivoOutletContext} />
    </NexivoAppShell>
  )
}
