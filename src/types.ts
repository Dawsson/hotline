// ── Protocol ──

export interface HotlineRequest {
  id: string
  type: string
  payload?: Record<string, unknown>
}

export interface HotlineResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

export interface HandlerField {
  name: string
  type: "string" | "number" | "boolean" | "json"
  optional?: boolean
  description?: string
}

export interface HandlerSchema {
  type: string
  description?: string
  fields?: HandlerField[]
}

export interface HotlineRegister {
  type: "register"
  role: "app"
  appId: string
  handlers: HandlerSchema[]
}

export type HotlineMessage = HotlineRequest | HotlineResponse | HotlineRegister

// ── Server internals ──

export interface AppConnection {
  appId: string
  connectedAt: number
  handlers?: HandlerSchema[]
}

export interface PendingRequest {
  cliSocket: unknown
  appSocket: unknown
  timer: ReturnType<typeof setTimeout>
}

// ── Constants ──

export const DEFAULT_PORT = 8675
export const DEFAULT_TIMEOUT = 5000
export const RECONNECT_CAP_MS = 30_000

export const LAUNCHD_LABEL = "com.hotline.server"
export const PID_DIR = `${process.env.HOME}/.hotline`
export const PID_FILE = `${PID_DIR}/server.pid`
export const LOG_FILE = `${PID_DIR}/server.log`
export const PLIST_PATH = `${process.env.HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
