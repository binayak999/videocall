import '../lib/livekitPolyfills'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0b0f14' },
          headerTintColor: '#f4f7fb',
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#0b0f14' },
        }}
      />
    </>
  )
}
