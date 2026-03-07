import { type ServerWebSocket } from "bun"
import {
  DEFAULT_PORT,
  PID_DIR,
  PID_FILE,
  type AppConnection,
  type HandlerSchema,
  type HotlineRequest,
  type HotlineResponse,
  type HotlineTarget,
  type PendingRequest,
} from "./types"

// ── State ──

const apps = new Map<ServerWebSocket<ClientData>, AppConnection>()
const watchers = new Set<ServerWebSocket<ClientData>>()
const waiters = new Set<ServerWebSocket<ClientData>>()
const pendingRequests = new Map<string, PendingRequest>()

interface ClientData {
  role: "app" | "cli" | "watch" | "wait"
  appId?: string
  deviceId?: string
  connectionId?: string
  waitEvent?: string // for wait: which event to listen for
}

function log(msg: string) {
  console.error(`[${new Date().toISOString()}] ${msg}`)
}

// ── App routing ──

function appTarget(conn: AppConnection): Required<Pick<AppConnection, "appId" | "connectionId">> & HotlineTarget {
  return {
    appId: conn.appId,
    connectionId: conn.connectionId,
    deviceId: conn.deviceId,
    deviceName: conn.deviceName,
    platform: conn.platform,
  }
}

function describeConnection(conn: AppConnection): string {
  const parts = [conn.appId]
  if (conn.deviceName) parts.push(conn.deviceName)
  if (conn.deviceId) parts.push(conn.deviceId)
  else parts.push(conn.connectionId)
  return parts.join(" @ ")
}

function matchesTarget(conn: AppConnection, target: HotlineTarget): boolean {
  if (target.connectionId) return conn.connectionId === target.connectionId
  if (target.deviceId) return conn.deviceId === target.deviceId
  if (target.appId) return conn.appId === target.appId
  return true
}

function findAppMatches(target: HotlineTarget): Array<[ServerWebSocket<ClientData>, AppConnection]> {
  return [...apps.entries()].filter(([, conn]) => matchesTarget(conn, target))
}

function resolveAppSocket(target: HotlineTarget): {
  socket: ServerWebSocket<ClientData> | null
  matches: Array<[ServerWebSocket<ClientData>, AppConnection]>
} {
  const matches = findAppMatches(target)
  if (matches.length !== 1) return { socket: null, matches }
  return { socket: matches[0][0], matches }
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
    connectionId: a.connectionId,
    connectedAt: a.connectedAt,
    deviceId: a.deviceId,
    deviceName: a.deviceName,
    platform: a.platform,
  }))
  return {
    port,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    apps: appList,
  }
})

handle("list-handlers", (payload) => {
  const target: HotlineTarget = {
    appId: payload?.appId as string | undefined,
    deviceId: payload?.deviceId as string | undefined,
    connectionId: payload?.connectionId as string | undefined,
  }
  const result: Array<AppConnection & { handlers: HandlerSchema[] }> = []
  for (const conn of apps.values()) {
    if (!matchesTarget(conn, target)) continue
    result.push({
      connectionId: conn.connectionId,
      appId: conn.appId,
      connectedAt: conn.connectedAt,
      deviceId: conn.deviceId,
      deviceName: conn.deviceName,
      platform: conn.platform,
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

function broadcast(event: { dir: "req" | "res"; appId?: string; target?: HotlineTarget; msg: any }) {
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
  log(`App disconnected: ${describeConnection(info)}`)
  broadcast({
    dir: "req",
    appId: info.appId,
    target: appTarget(info),
    msg: { type: "disconnect", appId: info.appId, ...appTarget(info) },
  })

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
    const deviceId = url.searchParams.get("device") || undefined
    const connectionId = url.searchParams.get("connection") || undefined
    const waitEvent = url.searchParams.get("event") || undefined

    let clientRole: ClientData["role"] = "cli"
    if (role === "watch") clientRole = "watch"
    else if (role === "wait") clientRole = "wait"

    const upgraded = server.upgrade(req, {
      data: { role: clientRole, appId, deviceId, connectionId, waitEvent },
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
      } else if (ws.data.role === "wait") {
        waiters.add(ws)
        log(`Waiter connected (event: ${ws.data.waitEvent})`)
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
        const connectionId = crypto.randomUUID()
        ws.data = { role: "app", appId: msg.appId, deviceId: msg.deviceId, connectionId }
        const conn: AppConnection = {
          connectionId,
          appId: msg.appId,
          connectedAt: Date.now(),
          deviceId: msg.deviceId,
          deviceName: msg.deviceName,
          platform: msg.platform,
        }
        if (msg.handlers) conn.handlers = msg.handlers
        apps.set(ws, conn)
        log(`App registered: ${describeConnection(conn)}${msg.handlers ? ` (${msg.handlers.length} handlers)` : ""}`)
        broadcast({
          dir: "req",
          appId: msg.appId,
          target: appTarget(conn),
          msg: { type: "register", appId: msg.appId, handlers: msg.handlers, ...appTarget(conn) },
        })
        return
      }

      // Event from app → broadcast to watchers + deliver to waiting CLIs
      if (msg.type === "event" && msg.event && ws.data.role === "app") {
        const appInfo = apps.get(ws)
        const event = {
          type: "event",
          event: msg.event,
          appId: appInfo?.appId,
          connectionId: appInfo?.connectionId,
          deviceId: appInfo?.deviceId,
          deviceName: appInfo?.deviceName,
          data: msg.data,
        }
        const payload = JSON.stringify(event)

        // Broadcast to watchers (shows in stream)
        for (const w of watchers) w.send(payload)

        // Deliver to matching waiters and close them
        for (const w of waiters) {
          const waiterTarget: HotlineTarget = {
            appId: w.data.appId,
            deviceId: w.data.deviceId,
            connectionId: w.data.connectionId,
          }
          if (w.data.waitEvent === msg.event && appInfo && matchesTarget(appInfo, waiterTarget)) {
            w.send(payload)
            w.close()
            waiters.delete(w)
          }
        }
        return
      }

      // Response from app (has `ok` field) → route back to CLI
      if ("ok" in msg && msg.id) {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          const appInfo = apps.get(pending.appSocket as ServerWebSocket<ClientData>)
          broadcast({ dir: "res", appId: appInfo?.appId, target: appInfo ? appTarget(appInfo) : undefined, msg })
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

        const target: HotlineTarget = {
          appId: ws.data.appId,
          deviceId: ws.data.deviceId,
          connectionId: ws.data.connectionId,
        }
        const { socket: appSocket, matches } = resolveAppSocket(target)

        if (!appSocket) {
          const hasExplicitTarget = Boolean(target.connectionId || target.deviceId || target.appId)
          const hint = matches.length > 1
            ? `Multiple app connections matched. Specify --device or --connection. Available: ${matches.map(([, conn]) => describeConnection(conn)).join(", ")}`
            : hasExplicitTarget
              ? `No app connected for target: ${target.connectionId ?? target.deviceId ?? target.appId}`
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
        broadcast({
          dir: "req",
          appId: appInfo?.appId,
          target: appInfo ? appTarget(appInfo) : undefined,
          msg: { id: msg.id, type: msg.type, payload: msg.payload },
        })
        appSocket.send(JSON.stringify({ id: msg.id, type: msg.type, payload: msg.payload }))
      }
    },

    close(ws) {
      if (ws.data.role === "app") {
        cleanupApp(ws)
      } else if (ws.data.role === "watch") {
        watchers.delete(ws)
        log("Watcher disconnected")
      } else if (ws.data.role === "wait") {
        waiters.delete(ws)
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
