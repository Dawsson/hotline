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

async function cmd() {
  const type = args[1]
  if (!type) die("Usage: hotline cmd <type> [--payload '{}'] [--app <id>]")

  let payload: Record<string, unknown> | undefined
  const payloadStr = flag("payload")
  if (payloadStr) {
    try {
      payload = JSON.parse(payloadStr)
    } catch {
      die("Invalid JSON payload")
    }
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
        const { dir, appId, msg } = JSON.parse(String(event.data))
        const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
        const app = appId ? `${dim}${appId}${reset}` : ""

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

async function logs() {
  if (!existsSync(LOG_FILE)) die("No log file found.")
  const proc = Bun.spawn(["tail", "-f", LOG_FILE], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  await proc.exited
}

const COMMANDS = ["status", "start", "stop", "cmd", "query", "watch", "setup", "teardown", "logs"]

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
  status                    Show connected apps
  cmd <type> [--payload]    Send command to app
  query <key>               Shorthand for get-state command
  watch                     Live stream of all messages
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
