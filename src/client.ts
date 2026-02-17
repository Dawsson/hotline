import { DEFAULT_PORT, RECONNECT_CAP_MS } from "./types"
import type { HotlineRequest, HotlineResponse, HandlerField, HandlerSchema } from "./types"

// ── Types ──

export interface HandlerConfig {
  handler: (payload: any) => any | Promise<any>
  fields?: HandlerField[]
  description?: string
}

type HandlerEntry = ((payload: any) => any | Promise<any>) | HandlerConfig

export interface HotlineOptions {
  port?: number
  appId: string
  handlers?: Record<string, HandlerEntry>
}

export interface Hotline {
  connect(): void
  disconnect(): void
  handle(type: string, fn: (payload: any) => any | Promise<any>): void
}

// ── Client ──

export function createHotline(options: HotlineOptions): Hotline {
  const port = options.port ?? DEFAULT_PORT
  const handlers = new Map<string, (payload: any) => any | Promise<any>>()
  const handlerSchemas: HandlerSchema[] = []
  let ws: WebSocket | null = null
  let reconnectDelay = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false

  // Register initial handlers and extract schemas
  if (options.handlers) {
    for (const [type, entry] of Object.entries(options.handlers)) {
      if (typeof entry === "function") {
        handlers.set(type, entry)
      } else {
        handlers.set(type, entry.handler)
        handlerSchemas.push({
          type,
          description: entry.description,
          fields: entry.fields,
        })
      }
    }
  }

  // Built-in ping handler
  handlers.set("ping", () => ({}))

  function connect() {
    // @ts-ignore — __DEV__ is defined in React Native
    if (typeof __DEV__ !== "undefined" && !__DEV__) return

    intentionalClose = false
    const url = `ws://localhost:${port}`

    ws = new WebSocket(url)

    ws.onopen = () => {
      reconnectDelay = 1000
      // Register with server
      const registerMsg: any = {
        type: "register",
        role: "app",
        appId: options.appId,
      }
      if (handlerSchemas.length > 0) {
        registerMsg.handlers = handlerSchemas
      }
      ws!.send(JSON.stringify(registerMsg))
    }

    ws.onmessage = async (event) => {
      let msg: HotlineRequest
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }

      if (!msg.id || !msg.type) return

      const handler = handlers.get(msg.type)
      if (handler) {
        try {
          const result = await handler(msg.payload ?? {})
          const response: HotlineResponse = {
            id: msg.id,
            ok: true,
            data: result ?? null,
          }
          ws?.send(JSON.stringify(response))
        } catch (err: any) {
          const response: HotlineResponse = {
            id: msg.id,
            ok: false,
            error: err?.message ?? "Handler error",
          }
          ws?.send(JSON.stringify(response))
        }
      } else {
        const response: HotlineResponse = {
          id: msg.id,
          ok: false,
          error: `Unknown command: ${msg.type}`,
        }
        ws?.send(JSON.stringify(response))
      }
    }

    ws.onclose = () => {
      ws = null
      if (!intentionalClose) {
        scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will fire after this
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS)
      connect()
    }, reconnectDelay)
  }

  function disconnect() {
    intentionalClose = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    ws?.close()
    ws = null
  }

  function handle(type: string, fn: HandlerEntry) {
    if (typeof fn === "function") {
      handlers.set(type, fn)
    } else {
      handlers.set(type, fn.handler)
      // Add schema if not already present
      const existing = handlerSchemas.findIndex((s) => s.type === type)
      const schema: HandlerSchema = { type, description: fn.description, fields: fn.fields }
      if (existing >= 0) handlerSchemas[existing] = schema
      else handlerSchemas.push(schema)
    }
  }

  return { connect, disconnect, handle }
}

// ── React Hook ──

let useRef: any
let useEffect: any

try {
  const React = require("react")
  useRef = React.useRef
  useEffect = React.useEffect
} catch {
  // React not available — hook will throw at call site
}

export function useHotline(options: HotlineOptions): Hotline {
  if (!useRef || !useEffect) {
    throw new Error("useHotline requires React")
  }

  const ref = useRef(null) as { current: Hotline | null }

  if (!ref.current) {
    ref.current = createHotline(options)
  }

  useEffect(() => {
    ref.current!.connect()
    return () => ref.current!.disconnect()
  }, [])

  return ref.current
}
