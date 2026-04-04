import { app, Tray, Menu, dialog, screen, nativeImage } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

// ---------------------------------------------------------------------------
// Native input (robotjs) — optional; gracefully skipped if not compiled
// ---------------------------------------------------------------------------
type Robot = {
  moveMouse(x: number, y: number): void
  mouseClick(btn?: string, double?: boolean): void
  scrollMouse(x: number, y: number): void
  keyTap(key: string, modifier?: string | string[]): void
  setMouseDelay(ms: number): void
  setKeyboardDelay(ms: number): void
}

let robot: Robot | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  robot = require('@jitsi/robotjs') as Robot
  robot!.setMouseDelay(0)
  robot!.setKeyboardDelay(0)
  console.log('✅  robotjs loaded – remote control ready')
} catch {
  console.warn('⚠️  robotjs not available. Run: npm run rebuild')
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BRIDGE_PORT = 7830
const BRIDGE_HOST = process.env.BANDR_BRIDGE_HOST?.trim() || '127.0.0.1'

const KEY_MAP: Record<string, string> = {
  Enter: 'enter', Backspace: 'backspace', Tab: 'tab',
  Escape: 'escape', Delete: 'delete', ' ': 'space',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Control: 'control', Shift: 'shift', Alt: 'alt', Meta: 'command',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tray: Tray | null = null
const clients = new Set<WebSocket>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeKey(key: string): string | null {
  if (KEY_MAP[key]) return KEY_MAP[key]
  if (key.length === 1) return key.toLowerCase()
  return null
}

interface ControlEventMsg {
  eventType: string
  normX?: number
  normY?: number
  button?: number
  key?: string
  deltaY?: number
}

function executeControlEvent(msg: ControlEventMsg): void {
  if (!robot) return
  const { width, height } = screen.getPrimaryDisplay().bounds
  const x = typeof msg.normX === 'number' ? Math.round(msg.normX * width) : 0
  const y = typeof msg.normY === 'number' ? Math.round(msg.normY * height) : 0

  switch (msg.eventType) {
    case 'mousemove':
      robot.moveMouse(x, y)
      break
    case 'click':
      robot.moveMouse(x, y)
      robot.mouseClick(msg.button === 2 ? 'right' : msg.button === 1 ? 'middle' : 'left')
      break
    case 'dblclick':
      robot.moveMouse(x, y)
      robot.mouseClick('left', true)
      break
    case 'scroll':
      if (typeof msg.deltaY === 'number') {
        robot.scrollMouse(0, msg.deltaY > 0 ? 3 : -3)
      }
      break
    case 'keydown': {
      const k = normalizeKey(msg.key ?? '')
      if (k) robot.keyTap(k)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // HTTP + WebSocket bridge server on localhost only
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    // Required by modern browsers when a public HTTPS origin calls a local/LAN bridge.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        version: app.getVersion(),
        remoteControl: robot !== null,
      }))
      return
    }
    res.writeHead(404); res.end()
  })

  const wss = new WebSocketServer({ server: http })

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)
    console.log('Web app connected via bridge')

    ws.on('message', async (raw: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }

      switch (msg.type) {
        // ── Controlled side: execute input ──────────────────────────────────
        case 'control-event':
          executeControlEvent(msg as unknown as ControlEventMsg)
          break

        // ── Controlled side: show native permission dialog ──────────────────
        case 'control-request': {
          const fromName = typeof msg.fromName === 'string' ? msg.fromName : 'Someone'
          const result = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Allow', 'Deny'],
            defaultId: 1,
            cancelId: 1,
            title: 'Remote Control Request',
            message: `${fromName} wants to control your computer`,
            detail: 'They will be able to move your mouse and use your keyboard.',
          })
          const accepted = result.response === 0
          ws.send(JSON.stringify({ type: 'control-response', to: msg.from, accepted }))
          tray?.setToolTip(
            accepted ? `Bandr Companion – Controlled by ${fromName}` : 'Bandr Companion – Idle'
          )
          break
        }

        // ── Either side: control session ended ──────────────────────────────
        case 'control-released':
          tray?.setToolTip('Bandr Companion – Idle')
          break
      }
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  http.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`Bandr Companion bridge → http://${BRIDGE_HOST}:${BRIDGE_PORT}`)
  })

  // System tray (macOS/Windows/Linux)
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Bandr Companion – Idle')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Bandr Companion', enabled: false },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: `Remote control: ${robot ? 'ready' : 'unavailable (run npm run rebuild)'}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]))

  // Hide from macOS dock – tray-only app
  app.dock?.hide()
}).catch(console.error)

// Keep alive when all windows are closed (it's a tray app)
app.on('window-all-closed', () => { /* intentionally empty */ })
