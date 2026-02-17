#!/usr/bin/env bun

import { DEFAULT_PORT, DEFAULT_TIMEOUT, PID_FILE, LOG_FILE } from "./types"
import { setup, teardown } from "./launchd"
import { readFileSync, existsSync } from "fs"

// ── Arg parsing ──

const args = process.argv.slice(2)
const command = args[0]

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= args.length) return undefined
  return args[i + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

const port = parseInt(flag("port") || "") || DEFAULT_PORT
const timeout = parseInt(flag("timeout") || "") || DEFAULT_TIMEOUT
const appId = flag("app")

// ── Helpers ──

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim())
    // Check if process is alive
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function wsRequest(
  type: string,
  payload?: Record<string, unknown>
): Promise<any> {
  const url = `ws://localhost:${port}${appId ? `?app=${encodeURIComponent(appId)}` : ""}`
  const id = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error("Request timed out"))
    }, timeout)

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, type, payload }))
    })

    ws.addEventListener("message", (event) => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(String(event.data))
        if (data.id === id) {
          ws.close()
          resolve(data)
        }
      } catch {}
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`Cannot connect to hotline server on port ${port}`))
    })
  })
}

// ── Commands ──

async function start() {
  if (readPid()) die("Server already running. Use `hotline stop` first.")

  if (hasFlag("daemon")) {
    const serverPath = new URL("./server.ts", import.meta.url).pathname
    const proc = Bun.spawn(["bun", "run", serverPath], {
      env: { ...process.env, HOTLINE_PORT: String(port) },
      stdio: ["ignore", "ignore", Bun.file(LOG_FILE)],
    })
    proc.unref()
    console.error(`Hotline server started (pid ${proc.pid}) on port ${port}`)
    return
  }

  // Foreground — just exec the server
  const serverPath = new URL("./server.ts", import.meta.url).pathname
  const proc = Bun.spawn(["bun", "run", serverPath], {
    env: { ...process.env, HOTLINE_PORT: String(port) },
    stdio: ["inherit", "inherit", "inherit"],
  })
  await proc.exited
}

async function stop() {
  const pid = readPid()
  if (!pid) die("No running server found.")
  process.kill(pid, "SIGTERM")
  console.error("Server stopped.")
}

async function restart() {
  const pid = readPid()
  if (pid) {
    process.kill(pid, "SIGTERM")
    console.error("Killed old server.")
    // Wait for launchd to relaunch (KeepAlive: true)
    let attempts = 0
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 250))
      const newPid = readPid()
      if (newPid && newPid !== pid) {
        console.error(`Server restarted (pid ${newPid}).`)
        return
      }
      attempts++
    }
    console.error("Server killed. Launchd should relaunch it shortly.")
  } else {
    // No running server — just start it
    console.error("No running server. Starting...")
    await start()
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

async function status() {
  try {
    const res = await wsRequest("list-apps")
    if (res.ok) {
      const { port: p, pid, uptime, apps } = res.data as any
      console.error(`Hotline running on port ${p} (pid ${pid}, uptime ${formatUptime(uptime)})`)
      if (apps.length === 0) {
        console.error("No apps connected.")
      } else {
        console.error(`${apps.length} app${apps.length > 1 ? "s" : ""} connected:`)
        for (const app of apps) {
          console.error(`  - ${app.appId}`)
        }
      }
      console.log(JSON.stringify(res.data))
    } else {
      die(res.error || "Unknown error")
    }
  } catch (e: any) {
    die(e.message)
  }
}

function collectInlineArgs(startIndex: number): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {}
  // Skip known global flags
  const globalFlags = new Set(["port", "timeout", "app", "payload", "passive", "daemon"])
  for (let i = startIndex; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      if (globalFlags.has(key)) { i++; continue }
      const val = args[i + 1]
      if (val === undefined || val.startsWith("--")) {
        payload[key] = true // boolean flag
      } else {
        // Auto-coerce numbers and booleans
        if (val === "true") payload[key] = true
        else if (val === "false") payload[key] = false
        else if (/^-?\d+(\.\d+)?$/.test(val)) payload[key] = Number(val)
        else {
          // Try JSON parse for objects/arrays
          try { payload[key] = JSON.parse(val) } catch { payload[key] = val }
        }
        i++
      }
    }
  }
  return Object.keys(payload).length > 0 ? payload : undefined
}

async function cmd() {
  const type = args[1]
  if (!type) die("Usage: hotline cmd <type> [--key value ...] [--payload '{}'] [--app <id>]")

  let payload: Record<string, unknown> | undefined
  const payloadStr = flag("payload")
  if (payloadStr) {
    try {
      payload = JSON.parse(payloadStr)
    } catch {
      die("Invalid JSON payload")
    }
  } else {
    payload = collectInlineArgs(2)
  }

  try {
    const res = await wsRequest(type, payload)
    if (res.ok) {
      console.log(JSON.stringify(res.data ?? null))
      process.exit(0)
    } else {
      console.error(res.error || "Command failed")
      process.exit(1)
    }
  } catch (e: any) {
    die(e.message)
  }
}

async function query() {
  const key = args[1]
  if (!key) die("Usage: hotline query <key> [--app <id>]")

  try {
    const res = await wsRequest("get-state", { key })
    if (res.ok) {
      console.log(JSON.stringify(res.data ?? null))
      process.exit(0)
    } else {
      console.error(res.error || "Query failed")
      process.exit(1)
    }
  } catch (e: any) {
    die(e.message)
  }
}

async function watch() {
  if (hasFlag("passive")) {
    return passiveWatch()
  }

  const { interactiveWatch } = await import("./interactive")
  return interactiveWatch(port)
}

async function passiveWatch() {
  const url = `ws://localhost:${port}?role=watch`
  const dim = "\x1b[2m"
  const reset = "\x1b[0m"
  const cyan = "\x1b[36m"
  const green = "\x1b[32m"
  const red = "\x1b[31m"

  console.error(`Watching hotline on port ${port}... (ctrl+c to stop)\n`)

  return new Promise<void>((_, reject) => {
    const ws = new WebSocket(url)

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data))
        const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })

        // Event from app
        if (data.type === "event") {
          const yellow = "\x1b[33m"
          const app = data.appId ? `${dim}${data.appId}${reset}` : ""
          const body = data.data != null ? ` ${dim}${JSON.stringify(data.data)}${reset}` : ""
          console.error(`${dim}${time}${reset} ${yellow}★${reset} ${yellow}${data.event}${reset} ${app}${body}`)
          return
        }

        const { dir, appId: evAppId, msg } = data
        const app = evAppId ? `${dim}${evAppId}${reset}` : ""

        if (dir === "req") {
          const arrow = `${cyan}▶${reset}`
          const type = `${cyan}${msg.type}${reset}`
          const payload = msg.payload ? ` ${dim}${JSON.stringify(msg.payload)}${reset}` : ""
          console.error(`${dim}${time}${reset} ${arrow} ${type} ${app}${payload}`)
        } else {
          const ok = msg.ok
          const arrow = ok ? `${green}◀${reset}` : `${red}◀${reset}`
          const status = ok ? `${green}ok${reset}` : `${red}err${reset}`
          const body = msg.data != null ? ` ${JSON.stringify(msg.data)}` : ""
          const err = msg.error ? ` ${red}${msg.error}${reset}` : ""
          console.error(`${dim}${time}${reset} ${arrow} ${status} ${app}${body}${err}`)
        }
      } catch {}
    })

    ws.addEventListener("error", () => {
      reject(new Error(`Cannot connect to hotline server on port ${port}`))
    })

    ws.addEventListener("close", () => {
      console.error("\nDisconnected.")
      process.exit(0)
    })
  })
}

async function wait() {
  const event = args[1]
  if (!event) die("Usage: hotline wait <event> [--timeout <ms>] [--app <id>]")

  const params = new URLSearchParams({ role: "wait", event })
  if (appId) params.set("app", appId)
  const url = `ws://localhost:${port}?${params}`

  return new Promise<void>((_, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      console.error(`Timed out waiting for event: ${event}`)
      process.exit(1)
    }, timeout)

    ws.addEventListener("message", (ev) => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(String(ev.data))
        console.log(JSON.stringify(data.data ?? null))
      } catch {}
      ws.close()
      process.exit(0)
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`Cannot connect to hotline server on port ${port}`))
    })

    ws.addEventListener("close", () => {})
  })
}

async function waitForApp() {
  const targetApp = appId || args[1]
  const url = `ws://localhost:${port}?role=watch`

  return new Promise<void>((_, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      console.error("Timed out waiting for app to connect.")
      process.exit(1)
    }, timeout)

    // Check if app is already connected
    ws.addEventListener("open", () => {
      const id = crypto.randomUUID()
      const checkWs = new WebSocket(`ws://localhost:${port}`)
      checkWs.addEventListener("open", () => {
        checkWs.send(JSON.stringify({ id, type: "list-apps" }))
      })
      checkWs.addEventListener("message", (ev) => {
        try {
          const data = JSON.parse(String(ev.data))
          if (data.id === id && data.ok) {
            const apps = (data.data as any).apps as { appId: string }[]
            const match = targetApp
              ? apps.find((a) => a.appId === targetApp)
              : apps[0]
            if (match) {
              clearTimeout(timer)
              console.log(JSON.stringify({ appId: match.appId }))
              ws.close()
              checkWs.close()
              process.exit(0)
            }
          }
        } catch {}
        checkWs.close()
      })
      checkWs.addEventListener("error", () => {})
    })

    // Watch for register events
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(String(ev.data))
        if (data.dir === "req" && data.msg?.type === "register") {
          const registeredApp = data.msg.appId || data.appId
          if (!targetApp || registeredApp === targetApp) {
            clearTimeout(timer)
            console.log(JSON.stringify({ appId: registeredApp }))
            ws.close()
            process.exit(0)
          }
        }
      } catch {}
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`Cannot connect to hotline server on port ${port}`))
    })
  })
}

async function logs() {
  if (!existsSync(LOG_FILE)) die("No log file found.")
  const proc = Bun.spawn(["tail", "-f", LOG_FILE], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  await proc.exited
}

const COMMANDS = ["status", "start", "stop", "restart", "cmd", "query", "watch", "wait", "wait-for-app", "setup", "teardown", "logs"]

function closestCommand(input: string): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const cmd of COMMANDS) {
    const d = levenshtein(input, cmd)
    if (d < bestDist && d <= 3) {
      bestDist = d
      best = cmd
    }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
      )
  return dp[m][n]
}

function usage(): never {
  if (command) {
    const suggestion = closestCommand(command)
    if (suggestion) {
      console.error(`Unknown command: ${command}. Did you mean "${suggestion}"?\n`)
    }
  }
  console.error(`hotline — local WebSocket dev bridge for React Native

Commands:
  start [--daemon]          Start server (foreground or background)
  stop                      Stop daemonized server
  restart                   Kill and relaunch server (picks up new code)
  status                    Show connected apps
  cmd <type> [--key val]    Send command to app (inline args or --payload)
  query <key>               Shorthand for get-state command
  wait <event>              Block until app emits event, print payload
  wait-for-app [appId]      Block until an app connects
  watch [--passive]         Interactive command browser (--passive for stream only)
  setup [--port N]          Install macOS launchd service
  teardown                  Remove launchd service
  logs                      Tail server log file

Flags:
  --port <number>           Server port (default: ${DEFAULT_PORT})
  --timeout <ms>            Request timeout (default: ${DEFAULT_TIMEOUT})
  --app <appId>             Target specific app`)
  process.exit(1)
}

// ── Main ──

switch (command) {
  case "start":
    await start()
    break
  case "stop":
    await stop()
    break
  case "restart":
    await restart()
    break
  case "status":
    await status()
    break
  case "cmd":
    await cmd()
    break
  case "query":
    await query()
    break
  case "watch":
    await watch()
    break
  case "wait":
    await wait()
    break
  case "wait-for-app":
    await waitForApp()
    break
  case "setup":
    await setup(port)
    break
  case "teardown":
    await teardown()
    break
  case "logs":
    await logs()
    break
  default:
    usage()
}
