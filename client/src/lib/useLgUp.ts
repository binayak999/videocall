import { useEffect, useState } from 'react'

/** True when viewport is at least Tailwind `lg` (1024px). */
export function useLgUp() {
  const [lg, setLg] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setLg(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return lg
}
