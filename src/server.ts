import { type ServerWebSocket } from "bun"
import {
  DEFAULT_PORT,
  PID_DIR,
  PID_FILE,
  type AppConnection,
  type HandlerSchema,
  type HotlineRequest,
  type HotlineResponse,
  type PendingRequest,
} from "./types"

// ── State ──

const apps = new Map<ServerWebSocket<ClientData>, AppConnection>()
const watchers = new Set<ServerWebSocket<ClientData>>()
const pendingRequests = new Map<string, PendingRequest>()

interface ClientData {
  role: "app" | "cli" | "watch"
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

// ── Server handlers ──

type ServerHandler = (payload: Record<string, unknown>) => any | Promise<any>
const serverHandlers = new Map<string, ServerHandler>()

export function handle(type: string, fn: ServerHandler) {
  serverHandlers.set(type, fn)
}

// Built-in handlers
handle("ping", () => ({}))

handle("list-apps", () => {
  const appList = [...apps.values()].map((a) => ({
    appId: a.appId,
    connectedAt: a.connectedAt,
  }))
  return {
    port,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    apps: appList,
  }
})

handle("list-handlers", (payload) => {
  const targetAppId = payload?.appId as string | undefined
  const result: { appId: string; handlers: HandlerSchema[] }[] = []
  for (const conn of apps.values()) {
    if (targetAppId && conn.appId !== targetAppId) continue
    result.push({
      appId: conn.appId,
      handlers: conn.handlers ?? [],
    })
  }
  return result
})

async function handleServerCommand(
  ws: ServerWebSocket<ClientData>,
  msg: HotlineRequest
): Promise<boolean> {
  const handler = serverHandlers.get(msg.type)
  if (!handler) return false

  try {
    const result = await handler(msg.payload ?? {})
    send(ws, { id: msg.id, ok: true, data: result ?? null })
  } catch (err: any) {
    send(ws, { id: msg.id, ok: false, error: err?.message ?? "Server handler error" })
  }
  return true
}

function send(ws: ServerWebSocket<ClientData>, data: HotlineResponse) {
  ws.send(JSON.stringify(data))
}

function broadcast(event: { dir: "req" | "res"; appId?: string; msg: any }) {
  if (watchers.size === 0) return
  const payload = JSON.stringify(event)
  for (const w of watchers) {
    w.send(payload)
  }
}

// ── Cleanup ──

function cleanupApp(ws: ServerWebSocket<ClientData>) {
  const info = apps.get(ws)
  if (!info) return

  apps.delete(ws)
  log(`App disconnected: ${info.appId}`)
  broadcast({ dir: "req", appId: info.appId, msg: { type: "disconnect", appId: info.appId } })

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
    const role = url.searchParams.get("role")
    const appId = url.searchParams.get("app") || undefined

    const upgraded = server.upgrade(req, {
      data: { role: (role === "watch" ? "watch" : "cli") as any, appId },
    })

    if (!upgraded) {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
  },

  websocket: {
    open(ws) {
      if (ws.data.role === "watch") {
        watchers.add(ws)
        log("Watcher connected")
      }
    },

    async message(ws, raw) {
      let msg: any
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }

      // App registration
      if (msg.type === "register" && msg.role === "app" && msg.appId) {
        ws.data = { role: "app", appId: msg.appId }
        const conn: AppConnection = { appId: msg.appId, connectedAt: Date.now() }
        if (msg.handlers) conn.handlers = msg.handlers
        apps.set(ws, conn)
        log(`App registered: ${msg.appId}${msg.handlers ? ` (${msg.handlers.length} handlers)` : ""}`)
        broadcast({ dir: "req", appId: msg.appId, msg: { type: "register", appId: msg.appId, handlers: msg.handlers } })
        return
      }

      // Response from app (has `ok` field) → route back to CLI
      if ("ok" in msg && msg.id) {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          const appInfo = apps.get(pending.appSocket as ServerWebSocket<ClientData>)
          broadcast({ dir: "res", appId: appInfo?.appId, msg })
          const cliWs = pending.cliSocket as ServerWebSocket<ClientData>
          cliWs.send(JSON.stringify(msg))
          pendingRequests.delete(msg.id)
        }
        return
      }

      // Request from CLI → route to app
      if (msg.id && msg.type) {
        // Server-handled commands (no app needed)
        if (await handleServerCommand(ws, msg)) return

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

        const appInfo = apps.get(appSocket)
        broadcast({ dir: "req", appId: appInfo?.appId, msg: { id: msg.id, type: msg.type, payload: msg.payload } })
        appSocket.send(JSON.stringify({ id: msg.id, type: msg.type, payload: msg.payload }))
      }
    },

    close(ws) {
      if (ws.data.role === "app") {
        cleanupApp(ws)
      } else if (ws.data.role === "watch") {
        watchers.delete(ws)
        log("Watcher disconnected")
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
