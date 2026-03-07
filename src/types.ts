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

export interface HotlineTarget {
  connectionId?: string
  deviceId?: string
  deviceName?: string
  platform?: string
}

export interface HotlineRegister {
  type: "register"
  role: "app"
  appId: string
  deviceId?: string
  deviceName?: string
  platform?: string
  handlers: HandlerSchema[]
}

export interface HotlineEvent {
  type: "event"
  event: string
  appId?: string
  data?: unknown
}

export type HotlineMessage = HotlineRequest | HotlineResponse | HotlineRegister | HotlineEvent

// ── Server internals ──

export interface AppConnection {
  connectionId: string
  appId: string
  connectedAt: number
  deviceId?: string
  deviceName?: string
  platform?: string
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
