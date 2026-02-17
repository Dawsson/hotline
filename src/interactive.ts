import { DEFAULT_PORT } from "./types"
import type { HandlerSchema, HandlerField } from "./types"

// ── ANSI helpers ──

const ESC = "\x1b["
const CLEAR_SCREEN = `${ESC}2J${ESC}H`
const CLEAR_LINE = `${ESC}2K`
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`

const dim = (s: string) => `${ESC}2m${s}${ESC}0m`
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`
const green = (s: string) => `${ESC}32m${s}${ESC}0m`
const red = (s: string) => `${ESC}31m${s}${ESC}0m`
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`
const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`

function moveTo(row: number, col: number) {
  return `${ESC}${row};${col}H`
}

// ── Types ──

interface AppInfo {
  appId: string
  handlers: HandlerSchema[]
}

interface StreamMessage {
  time: string
  dir: "req" | "res"
  appId?: string
  msg: any
}

type Mode = "selecting-app" | "selecting-command" | "editing-fields" | "sending"

// ── Interactive Watch ──

export async function interactiveWatch(port: number = DEFAULT_PORT) {
  const apps: AppInfo[] = []
  const stream: StreamMessage[] = []
  const MAX_STREAM = 100

  let mode: Mode = "selecting-app"
  let appIndex = 0
  let cmdIndex = 0
  let fieldIndex = 0
  let fieldValues: string[] = []
  let ws: WebSocket | null = null

  // Terminal dimensions
  let cols = process.stdout.columns || 80
  let rows = process.stdout.rows || 24

  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 80
    rows = process.stdout.rows || 24
    render()
  })

  // ── WebSocket connection ──

  function connectWatcher() {
    const url = `ws://localhost:${port}?role=watch`
    ws = new WebSocket(url)

    ws.addEventListener("open", () => {
      // Fetch initial app list with handlers
      fetchApps()
    })

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data))

        const time = new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })

        // Event from app
        if (data.type === "event") {
          stream.push({ time, dir: "event" as any, appId: data.appId, msg: { event: data.event, data: data.data } })
          if (stream.length > MAX_STREAM) stream.shift()
          render()
          return
        }

        const { dir, appId, msg } = data

        // Handle app register/disconnect events to refresh app list
        if (dir === "req" && (msg.type === "register" || msg.type === "disconnect")) {
          fetchApps()
        }

        stream.push({ time, dir, appId, msg })
        if (stream.length > MAX_STREAM) stream.shift()
        render()
      } catch {}
    })

    ws.addEventListener("close", () => {
      cleanup()
      process.stderr.write("\nDisconnected from server.\n")
      process.exit(0)
    })

    ws.addEventListener("error", () => {
      cleanup()
      process.stderr.write(`\nCannot connect to hotline server on port ${port}\n`)
      process.exit(1)
    })
  }

  // Fetch apps and their handlers via a separate short-lived connection
  function fetchApps() {
    const url = `ws://localhost:${port}`
    const fetchWs = new WebSocket(url)
    const id = crypto.randomUUID()

    fetchWs.addEventListener("open", () => {
      fetchWs.send(JSON.stringify({ id, type: "list-handlers" }))
    })

    fetchWs.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data.id === id && data.ok) {
          apps.length = 0
          for (const app of data.data as AppInfo[]) {
            apps.push(app)
          }
          // Reset selection if current index is out of bounds
          if (appIndex >= apps.length) appIndex = Math.max(0, apps.length - 1)
          // Auto-select if only one app
          if (apps.length === 1 && mode === "selecting-app") {
            mode = "selecting-command"
            cmdIndex = 0
          }
          render()
        }
      } catch {}
      fetchWs.close()
    })

    fetchWs.addEventListener("error", () => {})
  }

  // Send a command via a short-lived CLI connection
  function sendCommand(targetAppId: string, type: string, payload?: Record<string, unknown>) {
    const url = `ws://localhost:${port}?app=${encodeURIComponent(targetAppId)}`
    const cmdWs = new WebSocket(url)
    const id = crypto.randomUUID()

    cmdWs.addEventListener("open", () => {
      cmdWs.send(JSON.stringify({ id, type, payload }))
    })

    cmdWs.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data.id === id) {
          cmdWs.close()
          // Response will appear in stream via watcher
          mode = "selecting-command"
          render()
        }
      } catch {}
    })

    cmdWs.addEventListener("error", () => {
      cmdWs.close()
      mode = "selecting-command"
      render()
    })
  }

  // ── Helpers ──

  function selectedApp(): AppInfo | null {
    return apps[appIndex] ?? null
  }

  function selectedCommand(): HandlerSchema | null {
    const app = selectedApp()
    if (!app) return null
    return app.handlers[cmdIndex] ?? null
  }

  function truncate(s: string, max: number): string {
    if (s.length <= max) return s
    return s.slice(0, max - 1) + "…"
  }

  // ── Rendering ──

  function render() {
    const out: string[] = []

    // Calculate layout: stream takes top portion, panel takes bottom
    const panelHeight = getPanelHeight()
    const streamHeight = rows - panelHeight - 1 // -1 for divider

    out.push(HIDE_CURSOR)
    out.push(moveTo(1, 1))

    // ── Stream zone ──
    const visibleStream = stream.slice(-streamHeight)
    for (let i = 0; i < streamHeight; i++) {
      out.push(moveTo(i + 1, 1))
      out.push(CLEAR_LINE)
      if (i < visibleStream.length) {
        out.push(formatStreamLine(visibleStream[i]))
      }
    }

    // ── Divider ──
    const dividerRow = streamHeight + 1
    out.push(moveTo(dividerRow, 1))
    out.push(CLEAR_LINE)
    out.push(dim("─".repeat(cols)))

    // ── Panel zone ──
    const panelStart = dividerRow + 1
    const panelLines = renderPanel()
    for (let i = 0; i < panelHeight; i++) {
      out.push(moveTo(panelStart + i, 1))
      out.push(CLEAR_LINE)
      if (i < panelLines.length) {
        out.push(panelLines[i])
      }
    }

    process.stdout.write(out.join(""))
  }

  function getPanelHeight(): number {
    if (apps.length === 0) return 3
    if (mode === "selecting-app") return Math.min(apps.length + 2, 10)
    if (mode === "selecting-command") {
      const app = selectedApp()
      const count = app?.handlers.length ?? 0
      return Math.min(count + 2, 12)
    }
    if (mode === "editing-fields" || mode === "sending") {
      const cmd = selectedCommand()
      const fieldCount = cmd?.fields?.length ?? 0
      return fieldCount + 4 // header + fields + blank + hint
    }
    return 5
  }

  function formatStreamLine(m: StreamMessage): string {
    const time = dim(m.time)
    const app = m.appId ? dim(m.appId) : ""

    if ((m.dir as string) === "event") {
      const arrow = yellow("★")
      const name = yellow(m.msg.event)
      const body = m.msg.data != null ? " " + dim(JSON.stringify(m.msg.data)) : ""
      return truncate(`${time} ${arrow} ${name} ${app}${body}`, cols + 50)
    } else if (m.dir === "req") {
      const arrow = cyan("▶")
      const type = cyan(m.msg.type)
      const payload = m.msg.payload ? " " + dim(JSON.stringify(m.msg.payload)) : ""
      return truncate(`${time} ${arrow} ${type} ${app}${payload}`, cols + 50)
    } else {
      const ok = m.msg.ok
      const arrow = ok ? green("◀") : red("◀")
      const status = ok ? green("ok") : red("err")
      const body = m.msg.data != null ? " " + JSON.stringify(m.msg.data) : ""
      const err = m.msg.error ? " " + red(m.msg.error) : ""
      return truncate(`${time} ${arrow} ${status} ${app}${body}${err}`, cols + 50)
    }
  }

  function renderPanel(): string[] {
    const lines: string[] = []

    if (apps.length === 0) {
      lines.push(dim("  No apps connected. Waiting..."))
      lines.push("")
      lines.push(dim("  ctrl+c to quit"))
      return lines
    }

    if (mode === "selecting-app") {
      lines.push(bold("  Select app:") + dim("  (↑/↓ select, enter confirm, ctrl+c quit)"))
      for (let i = 0; i < apps.length; i++) {
        const prefix = i === appIndex ? cyan(" ▸ ") : "   "
        const label = i === appIndex ? bold(apps[i].appId) : apps[i].appId
        const count = apps[i].handlers.length
        const hint = count > 0 ? dim(` (${count} command${count !== 1 ? "s" : ""})`) : dim(" (no schema)")
        lines.push(`${prefix}${label}${hint}`)
      }
      return lines
    }

    const app = selectedApp()!

    if (mode === "selecting-command") {
      const handlers = app.handlers
      if (handlers.length === 0) {
        lines.push(bold(`  ${app.appId}`) + dim("  — no handler schemas advertised"))
        lines.push(dim("  esc to go back"))
        return lines
      }
      lines.push(bold(`  ${app.appId}`) + dim("  (↑/↓ select, enter confirm, esc back)"))
      for (let i = 0; i < handlers.length; i++) {
        const h = handlers[i]
        const prefix = i === cmdIndex ? cyan(" ▸ ") : "   "
        const label = i === cmdIndex ? bold(h.type) : h.type
        const desc = h.description ? dim(`  ${h.description}`) : ""
        lines.push(`${prefix}${label}${desc}`)
      }
      return lines
    }

    if (mode === "editing-fields" || mode === "sending") {
      const cmd = selectedCommand()!
      lines.push(bold(`  ${app.appId}`) + "  " + cyan(cmd.type) + (cmd.description ? dim(`  ${cmd.description}`) : ""))
      lines.push("")

      const fields = cmd.fields ?? []
      if (fields.length === 0) {
        lines.push(dim("  No fields — press enter to send"))
      } else {
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i]
          const active = mode === "editing-fields" && i === fieldIndex
          const value = fieldValues[i] ?? ""
          const opt = f.optional ? dim(" (optional)") : ""
          const typeHint = dim(` <${f.type}>`)

          if (active) {
            lines.push(`${yellow("▸")} ${bold(f.name)}:${opt}${typeHint} ${inverse(" " + value + " ")}`)
          } else {
            lines.push(`  ${f.name}:${opt}${typeHint} ${value || dim("—")}`)
          }
        }
      }

      lines.push("")
      if (mode === "editing-fields") {
        lines.push(dim("  tab/shift+tab move fields, enter send, esc back"))
      } else {
        lines.push(dim("  sending..."))
      }
      return lines
    }

    return lines
  }

  // ── Input handling ──

  function handleKey(buf: Buffer) {
    const key = buf.toString("utf-8")
    const hex = buf.toString("hex")

    // Ctrl+C
    if (key === "\x03") {
      cleanup()
      process.exit(0)
    }

    // Escape sequences
    if (hex === "1b5b41") return handleArrow("up")
    if (hex === "1b5b42") return handleArrow("down")

    // Escape key (just 1b, not a sequence)
    if (hex === "1b") return handleEscape()

    // Tab
    if (key === "\t") return handleTab(false)
    // Shift+Tab (1b5b5a)
    if (hex === "1b5b5a") return handleTab(true)

    // Enter
    if (key === "\r" || key === "\n") return handleEnter()

    // Backspace
    if (key === "\x7f" || key === "\b") return handleBackspace()

    // Regular character input
    if (mode === "editing-fields" && key.length === 1 && key >= " ") {
      return handleCharInput(key)
    }
  }

  function handleArrow(dir: "up" | "down") {
    if (mode === "selecting-app") {
      if (dir === "up") appIndex = Math.max(0, appIndex - 1)
      else appIndex = Math.min(apps.length - 1, appIndex + 1)
      render()
    } else if (mode === "selecting-command") {
      const app = selectedApp()
      if (!app) return
      if (dir === "up") cmdIndex = Math.max(0, cmdIndex - 1)
      else cmdIndex = Math.min(app.handlers.length - 1, cmdIndex + 1)
      render()
    }
  }

  function handleEscape() {
    if (mode === "editing-fields") {
      mode = "selecting-command"
      render()
    } else if (mode === "selecting-command") {
      if (apps.length > 1) {
        mode = "selecting-app"
        render()
      }
    }
  }

  function handleTab(shift: boolean) {
    if (mode !== "editing-fields") return
    const cmd = selectedCommand()
    if (!cmd?.fields?.length) return
    if (shift) {
      fieldIndex = Math.max(0, fieldIndex - 1)
    } else {
      fieldIndex = Math.min(cmd.fields.length - 1, fieldIndex + 1)
    }
    render()
  }

  function handleEnter() {
    if (mode === "selecting-app") {
      if (apps.length === 0) return
      mode = "selecting-command"
      cmdIndex = 0
      render()
    } else if (mode === "selecting-command") {
      const app = selectedApp()
      if (!app || app.handlers.length === 0) return
      mode = "editing-fields"
      fieldIndex = 0
      const cmd = selectedCommand()
      fieldValues = (cmd?.fields ?? []).map(() => "")
      render()
    } else if (mode === "editing-fields") {
      // Send the command
      const app = selectedApp()
      const cmd = selectedCommand()
      if (!app || !cmd) return

      const payload: Record<string, unknown> = {}
      const fields = cmd.fields ?? []
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]
        const raw = fieldValues[i] ?? ""
        if (!raw && f.optional) continue
        if (!raw && !f.optional) {
          // Required field empty — focus it
          fieldIndex = i
          render()
          return
        }
        payload[f.name] = coerceValue(raw, f.type)
      }

      mode = "sending"
      render()
      sendCommand(app.appId, cmd.type, Object.keys(payload).length > 0 ? payload : undefined)
    }
  }

  function handleBackspace() {
    if (mode !== "editing-fields") return
    const current = fieldValues[fieldIndex] ?? ""
    fieldValues[fieldIndex] = current.slice(0, -1)
    render()
  }

  function handleCharInput(ch: string) {
    if (mode !== "editing-fields") return
    fieldValues[fieldIndex] = (fieldValues[fieldIndex] ?? "") + ch
    render()
  }

  function coerceValue(raw: string, type: HandlerField["type"]): unknown {
    switch (type) {
      case "number":
        return Number(raw)
      case "boolean":
        return raw === "true" || raw === "1" || raw === "yes"
      case "json":
        try { return JSON.parse(raw) } catch { return raw }
      default:
        return raw
    }
  }

  // ── Lifecycle ──

  function cleanup() {
    process.stdin.setRawMode?.(false)
    process.stdout.write(SHOW_CURSOR)
    process.stdout.write(`${ESC}?1049l`) // restore normal screen buffer
    ws?.close()
  }

  // Enter alternate screen buffer and raw mode
  process.stdout.write(`${ESC}?1049h`) // alternate screen buffer
  process.stdout.write(CLEAR_SCREEN)
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on("data", handleKey)

  // Handle SIGINT gracefully
  process.on("SIGINT", () => {
    cleanup()
    process.exit(0)
  })

  connectWatcher()
  render()

  // Keep alive
  return new Promise<void>(() => {})
}
