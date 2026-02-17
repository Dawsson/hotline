import { type ServerWebSocket } from "bun"
import {
  DEFAULT_PORT,
  PID_DIR,
  PID_FILE,
  type AppConnection,
  type HotlineRequest,
  type HotlineResponse,
  type PendingRequest,
} from "./types"

// ── State ──

const apps = new Map<ServerWebSocket<ClientData>, AppConnection>()
const pendingRequests = new Map<string, PendingRequest>()

interface ClientData {
  role: "app" | "cli"
  appId?: string // for apps: their id; for cli: target app id
}

function log(msg: string) {
  console.error(`[${new Date().toISOString()}] ${msg}`)
}

// ── App routing ──

function findAppSocket(targetAppId?: string): ServerWebSocket<ClientData> | null {
  const entries = [...apps.entries()]

  if (entries.length === 0) return null

  if (!targetAppId) {
    if (entries.length === 1) return entries[0][0]
    return null // ambiguous — caller handles error
  }

  const matches = entries.filter(([, info]) => info.appId === targetAppId)
  if (matches.length === 0) return null
  return matches[0][0] // first match
}

function listAppIds(): string[] {
  return [...new Set([...apps.values()].map((a) => a.appId))]
}

// ── Built-in commands ──

function handleBuiltIn(
  ws: ServerWebSocket<ClientData>,
  msg: HotlineRequest
): boolean {
  if (msg.type === "ping") {
    send(ws, { id: msg.id, ok: true })
    return true
  }

  if (msg.type === "list-apps") {
    const appList = [...apps.values()].map((a) => ({
      appId: a.appId,
      connectedAt: a.connectedAt,
    }))
    send(ws, {
      id: msg.id,
      ok: true,
      data: {
        port,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        apps: appList,
      },
    })
    return true
  }

  return false
}

function send(ws: ServerWebSocket<ClientData>, data: HotlineResponse) {
  ws.send(JSON.stringify(data))
}

// ── Cleanup ──

function cleanupApp(ws: ServerWebSocket<ClientData>) {
  const info = apps.get(ws)
  if (!info) return

  apps.delete(ws)
  log(`App disconnected: ${info.appId}`)

  // Fail all pending requests routed to this app
  for (const [id, pending] of pendingRequests) {
    if (pending.appSocket === ws) {
      clearTimeout(pending.timer)
      const cliWs = pending.cliSocket as ServerWebSocket<ClientData>
      send(cliWs, { id, ok: false, error: "App disconnected" })
      pendingRequests.delete(id)
    }
  }
}

// ── Server ──

const port = parseInt(process.env.HOTLINE_PORT || "") || DEFAULT_PORT

import { mkdirSync, writeFileSync, unlinkSync } from "fs"
mkdirSync(PID_DIR, { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

const server = Bun.serve<ClientData>({
  port,

  fetch(req, server) {
    const url = new URL(req.url)
    const appId = url.searchParams.get("app") || undefined

    const upgraded = server.upgrade(req, {
      data: { role: "cli" as const, appId },
    })

    if (!upgraded) {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
  },

  websocket: {
    open(_ws) {},

    message(ws, raw) {
      let msg: any
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }

      // App registration
      if (msg.type === "register" && msg.role === "app" && msg.appId) {
        ws.data = { role: "app", appId: msg.appId }
        apps.set(ws, { appId: msg.appId, connectedAt: Date.now() })
        log(`App registered: ${msg.appId}`)
        return
      }

      // Response from app (has `ok` field) → route back to CLI
      if ("ok" in msg && msg.id) {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          const cliWs = pending.cliSocket as ServerWebSocket<ClientData>
          cliWs.send(JSON.stringify(msg))
          pendingRequests.delete(msg.id)
        }
        return
      }

      // Request from CLI → route to app
      if (msg.id && msg.type) {
        // Built-in commands (no app needed)
        if (handleBuiltIn(ws, msg)) return

        const targetAppId = ws.data.appId
        const appSocket = findAppSocket(targetAppId)

        if (!appSocket && !targetAppId && apps.size > 1) {
          send(ws, {
            id: msg.id,
            ok: false,
            error: `Multiple apps connected. Specify --app. Available: ${listAppIds().join(", ")}`,
          })
          return
        }

        if (!appSocket) {
          const hint = targetAppId
            ? `No app connected with id: ${targetAppId}`
            : "No app connected"
          send(ws, { id: msg.id, ok: false, error: hint })
          return
        }

        // Forward to app, track pending
        const timer = setTimeout(() => {
          pendingRequests.delete(msg.id)
          send(ws, { id: msg.id, ok: false, error: "Request timed out" })
        }, 30_000) // server-side safety timeout

        pendingRequests.set(msg.id, {
          cliSocket: ws,
          appSocket,
          timer,
        })

        appSocket.send(JSON.stringify({ id: msg.id, type: msg.type, payload: msg.payload }))
      }
    },

    close(ws) {
      if (ws.data.role === "app") {
        cleanupApp(ws)
      }
    },
  },
})

log(`Hotline server listening on port ${port}`)

// ── Graceful shutdown ──

function shutdown() {
  log("Shutting down...")
  try {
    unlinkSync(PID_FILE)
  } catch {}

  // Fail all pending requests
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer)
  }
  pendingRequests.clear()

  server.stop()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
