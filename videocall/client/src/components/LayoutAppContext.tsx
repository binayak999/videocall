import { createContext, useContext } from 'react'

export type LayoutAppContextValue = {
  systemRtcLoaded: boolean
  canControlRtcMode: boolean
}

const defaultValue: LayoutAppContextValue = {
  systemRtcLoaded: false,
  canControlRtcMode: false,
}

export const LayoutAppContext = createContext<LayoutAppContextValue>(defaultValue)

export function useLayoutApp(): LayoutAppContextValue {
  return useContext(LayoutAppContext)
}
