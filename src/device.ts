import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { basename, join } from "path"

interface DeviceGlobals {
  port: number
  timeout: number
  appId?: string
}

interface QueueTicket {
  ticketId: string
  agent: string
  createdAt: string
  pid: number
}

interface LockInfo {
  agent: string
  pid: number
  ticketId: string
  createdAt: string
  udid: string
}

interface DeviceStep {
  type: string
  note?: string
  important?: boolean
  [key: string]: unknown
}

interface RunScript {
  bundleId?: string
  appId?: string
  summary?: string
  steps: DeviceStep[]
}

interface IssueIndexEntry {
  id: string
  file: string
  summary: string
  embedding: number[]
  createdAt: string
  updatedAt: string
}

interface RunContext {
  agent: string
  bundleId?: string
  appId?: string
  udid: string
  runId: string
  runDir: string
  startMs: number
  port: number
  defaultTimeoutMs: number
  importantShots: { path: string; reason: string }[]
  steps: Array<{
    index: number
    type: string
    note?: string
    ok: boolean
    startedAt: string
    endedAt: string
    durationMs: number
    error?: string
    screenshot?: string
  }>
}

interface VideoConfig {
  enabled: boolean
  rawPath: string
  compressedPath: string
  maxBytes: number
}

interface VideoCapture {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  rawPath: string
}

type DiscordScreenshotMode = "none" | "failure" | "important"

const DEVICE_HOME = join(process.env.HOME || ".", ".hotline", "device")
const QUEUE_DIR = join(DEVICE_HOME, "queue")
const LOCK_DIR = join(DEVICE_HOME, "lock")
const INDEX_FILE = join(DEVICE_HOME, "issue-index.json")

const DEFAULT_RUNS_DIR = join(process.cwd(), "runs")
const DEFAULT_ISSUES_DIR = join(process.cwd(), "issues")
const DEFAULT_MAX_VIDEO_BYTES = 24 * 1024 * 1024

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= args.length) return undefined
  return args[i + 1]
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`)
}

function toNumber(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${label}`)
  return parsed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function formatNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLockInfo(): LockInfo | null {
  const infoPath = join(LOCK_DIR, "info.json")
  if (!existsSync(infoPath)) return null
  const raw = readFileSync(infoPath, "utf-8")
  return safeJsonParse<LockInfo | null>(raw, null)
}

function clearStaleLock() {
  const info = readLockInfo()
  if (!info) {
    if (existsSync(LOCK_DIR)) rmSync(LOCK_DIR, { recursive: true, force: true })
    return
  }
  if (!isPidAlive(info.pid)) {
    rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

function readQueueTickets(): string[] {
  if (!existsSync(QUEUE_DIR)) return []
  return readdirSync(QUEUE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
}

function readTicket(ticketPath: string): QueueTicket {
  const raw = readFileSync(ticketPath, "utf-8")
  return safeJsonParse<QueueTicket>(raw, {
    ticketId: "unknown",
    agent: "unknown",
    createdAt: new Date(0).toISOString(),
    pid: -1,
  })
}

function clearDeadTickets() {
  if (!existsSync(QUEUE_DIR)) return
  for (const name of readQueueTickets()) {
    const path = join(QUEUE_DIR, name)
    const ticket = readTicket(path)
    if (ticket.pid <= 0 || !isPidAlive(ticket.pid)) {
      rmSync(path, { force: true })
    }
  }
}

async function runCommand(cmd: string[], timeoutMs: number): Promise<{ out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {}
  }, timeoutMs)

  const [code, out, err] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])

  clearTimeout(timeout)

  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${code}): ${err.trim() || out.trim() || "unknown error"}`)
  }

  return { out, err }
}

async function runBestEffortCommand(cmd: string[], timeoutMs: number): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const result = await runCommand(cmd, timeoutMs)
    return { ok: true, out: result.out, err: result.err }
  } catch (error: any) {
    return { ok: false, out: "", err: error?.message || String(error) }
  }
}

async function commandExists(binary: string): Promise<boolean> {
  const result = await runBestEffortCommand(["which", binary], 2_000)
  return result.ok && result.out.trim().length > 0
}

function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function getVideoDurationSec(path: string): Promise<number | null> {
  const hasFfprobe = await commandExists("ffprobe")
  if (!hasFfprobe) return null

  const res = await runBestEffortCommand(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", path],
    10_000
  )
  if (!res.ok) return null
  const duration = Number(res.out.trim())
  if (!Number.isFinite(duration) || duration <= 0) return null
  return duration
}

async function getBootedUdid(timeoutMs: number): Promise<string> {
  const { out } = await runCommand(["xcrun", "simctl", "list", "devices", "--json"], timeoutMs)
  const payload = safeJsonParse<{ devices: Record<string, Array<{ state: string; udid: string }> > }>(out, { devices: {} })
  for (const runtime of Object.values(payload.devices)) {
    const booted = runtime.find((device) => device.state === "Booted")
    if (booted?.udid) return booted.udid
  }
  throw new Error("No booted simulator found. Boot one simulator and retry.")
}

async function resolveUdid(args: string[], timeoutMs: number): Promise<string> {
  const explicit = parseFlag(args, "udid") || process.env.HOTLINE_SIM_UDID
  if (explicit) return explicit
  return getBootedUdid(timeoutMs)
}

function embedText(input: string, dims = 256): number[] {
  const vec = new Array(dims).fill(0)
  const tokens = input.toLowerCase().match(/[a-z0-9_]+/g) || []
  for (const token of tokens) {
    let hash = 2166136261
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    const idx = Math.abs(hash) % dims
    const sign = (hash & 1) === 0 ? 1 : -1
    vec[idx] += sign
  }

  const norm = Math.sqrt(vec.reduce((acc, n) => acc + n * n, 0))
  if (norm === 0) return vec
  return vec.map((n) => n / norm)
}

function cosine(a: number[], b: number[]): number {
  const max = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < max; i++) sum += a[i] * b[i]
  return sum
}

function loadIssueIndex(): IssueIndexEntry[] {
  if (!existsSync(INDEX_FILE)) return []
  return safeJsonParse<IssueIndexEntry[]>(readFileSync(INDEX_FILE, "utf-8"), [])
}

function saveIssueIndex(entries: IssueIndexEntry[]) {
  ensureDir(DEVICE_HOME)
  writeFileSync(INDEX_FILE, `${JSON.stringify(entries, null, 2)}\n`)
}

function searchIssueMemory(text: string, threshold: number): { hit: IssueIndexEntry; score: number } | null {
  const entries = loadIssueIndex()
  if (entries.length === 0) return null
  const target = embedText(text)

  let best: { hit: IssueIndexEntry; score: number } | null = null
  for (const entry of entries) {
    const score = cosine(target, entry.embedding)
    if (!best || score > best.score) {
      best = { hit: entry, score }
    }
  }

  if (!best || best.score < threshold) return null
  return best
}

function addIssueMemory(issuesDir: string, summary: string, details: string, runId: string): IssueIndexEntry {
  ensureDir(issuesDir)
  const now = new Date().toISOString()
  const id = `${runId}-${Date.now()}`
  const file = `${id}.md`
  const path = join(issuesDir, file)
  const body = `# Issue ${id}\n\n## Summary\n${summary}\n\n## Details\n${details}\n\n## Created\n${now}\n`
  writeFileSync(path, body)

  const entry: IssueIndexEntry = {
    id,
    file,
    summary,
    embedding: embedText(`${summary}\n${details}`),
    createdAt: now,
    updatedAt: now,
  }
  const entries = loadIssueIndex()
  entries.push(entry)
  saveIssueIndex(entries)
  return entry
}

async function waitForHotlineEvent(event: string, appId: string | undefined, port: number, timeoutMs: number): Promise<unknown> {
  const params = new URLSearchParams({ role: "wait", event })
  if (appId) params.set("app", appId)
  const url = `ws://localhost:${port}?${params}`

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out waiting for hotline event: ${event}`))
    }, timeoutMs)

    ws.addEventListener("message", (ev) => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(String(ev.data))
        resolve(data.data ?? null)
      } catch {
        resolve(null)
      }
      ws.close()
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`Cannot connect to hotline server on port ${port}`))
    })
  })
}

async function activateSimulator() {
  await runCommand(["osascript", "-e", "tell application \"Simulator\" to activate"], 5_000)
}

async function getSimulatorWindowBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  const { out } = await runCommand(
    [
      "osascript",
      "-e",
      "tell application \"System Events\" to tell process \"Simulator\" to get {position, size} of front window",
    ],
    5_000
  )

  const nums = out
    .trim()
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n))

  if (nums.length < 4) {
    throw new Error(`Unable to parse Simulator window bounds: ${out.trim()}`)
  }

  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] }
}

async function getScreenshotSize(udid: string): Promise<{ width: number; height: number }> {
  ensureDir(DEVICE_HOME)
  const tmpPath = join(DEVICE_HOME, `screen-${process.pid}.png`)
  await runCommand(["xcrun", "simctl", "io", udid, "screenshot", tmpPath], 15_000)
  const { out } = await runCommand(["sips", "-g", "pixelWidth", "-g", "pixelHeight", tmpPath], 5_000)
  rmSync(tmpPath, { force: true })

  const widthMatch = out.match(/pixelWidth:\s*(\d+)/)
  const heightMatch = out.match(/pixelHeight:\s*(\d+)/)
  if (!widthMatch || !heightMatch) {
    throw new Error(`Unable to parse screenshot size from sips output: ${out.trim()}`)
  }

  return { width: Number(widthMatch[1]), height: Number(heightMatch[1]) }
}

async function mapDeviceToScreen(udid: string, x: number, y: number): Promise<{ x: number; y: number }> {
  const [bounds, size] = await Promise.all([getSimulatorWindowBounds(), getScreenshotSize(udid)])

  const scale = Math.min(bounds.width / size.width, bounds.height / size.height)
  const contentWidth = size.width * scale
  const contentHeight = size.height * scale
  const insetX = (bounds.width - contentWidth) / 2
  const insetY = (bounds.height - contentHeight) / 2

  return {
    x: Math.round(bounds.x + insetX + x * scale),
    y: Math.round(bounds.y + insetY + y * scale),
  }
}

async function clickWithFallback(udid: string, x: number, y: number, timeoutMs: number) {
  const simctl = await runBestEffortCommand(["xcrun", "simctl", "io", udid, "tap", String(x), String(y)], timeoutMs)
  if (simctl.ok) return

  await activateSimulator()
  const mapped = await mapDeviceToScreen(udid, x, y)
  await runCommand(["cliclick", `c:${mapped.x},${mapped.y}`], timeoutMs)
}

async function swipeWithFallback(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  timeoutMs: number
) {
  const simctl = await runBestEffortCommand(
    ["xcrun", "simctl", "io", udid, "swipe", String(x1), String(y1), String(x2), String(y2)],
    timeoutMs
  )
  if (simctl.ok) return

  await activateSimulator()
  const start = await mapDeviceToScreen(udid, x1, y1)
  const end = await mapDeviceToScreen(udid, x2, y2)
  await runCommand(["cliclick", `dd:${start.x},${start.y}`, "w:120", `du:${end.x},${end.y}`], timeoutMs)
}

async function typeWithFallback(udid: string, text: string, timeoutMs: number) {
  const simctl = await runBestEffortCommand(["xcrun", "simctl", "io", udid, "text", text], timeoutMs)
  if (simctl.ok) return

  await activateSimulator()
  await runCommand(["cliclick", `t:${text}`], timeoutMs)
}

function markImportant(ctx: RunContext, screenshotPath: string, reason: string) {
  if (!ctx.importantShots.some((item) => item.path === screenshotPath)) {
    ctx.importantShots.push({ path: screenshotPath, reason })
  }
}

async function captureStepScreenshot(ctx: RunContext, label: string, importantReason?: string): Promise<string> {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_")
  const path = join(ctx.runDir, `${safeLabel}.png`)
  await runCommand(["xcrun", "simctl", "io", ctx.udid, "screenshot", path], 15_000)
  if (importantReason) markImportant(ctx, path, importantReason)
  return path
}

async function executeStep(ctx: RunContext, step: DeviceStep, index: number) {
  const type = String(step.type || "").toLowerCase()
  const startedAt = new Date().toISOString()
  const start = Date.now()
  const timeoutMs = step.timeoutMs ? toNumber(step.timeoutMs, "timeoutMs") : ctx.defaultTimeoutMs

  let screenshot: string | undefined
  try {
    switch (type) {
      case "tap": {
        const x = toNumber(step.x, "x")
        const y = toNumber(step.y, "y")
        await clickWithFallback(ctx.udid, x, y, timeoutMs)
        break
      }
      case "type": {
        const text = String(step.text ?? "")
        await typeWithFallback(ctx.udid, text, timeoutMs)
        break
      }
      case "swipe":
      case "scroll": {
        const x1 = toNumber(step.x1, "x1")
        const y1 = toNumber(step.y1, "y1")
        const x2 = toNumber(step.x2, "x2")
        const y2 = toNumber(step.y2, "y2")
        await swipeWithFallback(ctx.udid, x1, y1, x2, y2, timeoutMs)
        break
      }
      case "launch": {
        const bundleId = String(step.bundleId || ctx.bundleId || "")
        if (!bundleId) throw new Error("launch requires bundleId")
        await runCommand(["xcrun", "simctl", "launch", ctx.udid, bundleId], timeoutMs)
        break
      }
      case "reset":
      case "reset-app": {
        const bundleId = String(step.bundleId || ctx.bundleId || "")
        if (!bundleId) throw new Error("reset requires bundleId")
        await runCommand(["xcrun", "simctl", "terminate", ctx.udid, bundleId], timeoutMs).catch(() => undefined)
        await runCommand(["xcrun", "simctl", "launch", ctx.udid, bundleId], timeoutMs)
        break
      }
      case "screenshot": {
        screenshot = await captureStepScreenshot(ctx, `step-${String(index + 1).padStart(3, "0")}-manual`, step.important ? "marked important" : undefined)
        break
      }
      case "record": {
        const seconds = step.seconds ? toNumber(step.seconds, "seconds") : 5
        const videoPath = join(ctx.runDir, `step-${String(index + 1).padStart(3, "0")}.mp4`)
        const proc = Bun.spawn(["xcrun", "simctl", "io", ctx.udid, "recordVideo", videoPath], {
          stdout: "pipe",
          stderr: "pipe",
        })
        await sleep(Math.max(1, seconds) * 1000)
        proc.kill("SIGINT")
        await proc.exited
        break
      }
      case "simctl": {
        const raw = step.args
        if (!Array.isArray(raw) || raw.length === 0) throw new Error("simctl action requires args array")
        const args = raw.map((item) => String(item))
        await runCommand(["xcrun", "simctl", ...args], timeoutMs)
        break
      }
      case "wait-event": {
        const event = String(step.event || "")
        if (!event) throw new Error("wait-event requires event")
        const appId = String(step.appId || ctx.appId || "") || undefined
        await waitForHotlineEvent(event, appId, ctx.port, timeoutMs)
        break
      }
      case "sleep": {
        const ms = step.ms ? toNumber(step.ms, "ms") : 250
        await sleep(ms)
        break
      }
      default:
        throw new Error(`Unsupported action type: ${type}`)
    }

    if (!screenshot) {
      const importantReason = step.important ? `step ${index + 1} marked important` : undefined
      screenshot = await captureStepScreenshot(ctx, `step-${String(index + 1).padStart(3, "0")}-${type}`, importantReason)
    }

    const endedAt = new Date().toISOString()
    ctx.steps.push({
      index: index + 1,
      type,
      note: step.note,
      ok: true,
      startedAt,
      endedAt,
      durationMs: Date.now() - start,
      screenshot,
    })
    return
  } catch (error: any) {
    try {
      const failureShot = await captureStepScreenshot(ctx, `step-${String(index + 1).padStart(3, "0")}-failure`, "failure")
      screenshot = failureShot
    } catch {
      screenshot = undefined
    }

    const endedAt = new Date().toISOString()
    ctx.steps.push({
      index: index + 1,
      type,
      note: step.note,
      ok: false,
      startedAt,
      endedAt,
      durationMs: Date.now() - start,
      screenshot,
      error: error?.message || String(error),
    })
    throw error
  }
}

function parseScript(scriptPath: string): RunScript {
  if (!existsSync(scriptPath)) throw new Error(`Script file not found: ${scriptPath}`)
  const payload = safeJsonParse<RunScript>(readFileSync(scriptPath, "utf-8"), { steps: [] })
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    throw new Error("Script must include a non-empty steps array")
  }
  return payload
}

async function postDiscordSummary(
  webhookUrl: string,
  ctx: RunContext,
  ok: boolean,
  message: string,
  videoPath?: string,
  screenshots: Array<{ path: string; reason: string }> = []
) {
  const embeds: Array<Record<string, unknown>> = []
  const form = new FormData()
  let fileIndex = 0

  for (let i = 0; i < screenshots.length; i++) {
    const item = screenshots[i]
    const fileName = basename(item.path)
    form.set(`files[${fileIndex}]`, Bun.file(item.path), fileName)
    embeds.push({
      title: `Screenshot ${i + 1}`,
      description: item.reason,
      image: { url: `attachment://${fileName}` },
    })
    fileIndex += 1
  }

  if (videoPath && existsSync(videoPath)) {
    const fileName = basename(videoPath)
    form.set(`files[${fileIndex}]`, Bun.file(videoPath), fileName)
  }

  const content = `${ok ? "PASS" : "FAIL"} agent=${ctx.agent} run=${ctx.runId} steps=${ctx.steps.length}`
  form.set(
    "payload_json",
    JSON.stringify({
      content,
      embeds: [
        {
          title: "Hotline Device Summary",
          description: message,
          fields: [
            { name: "Agent", value: ctx.agent, inline: true },
            { name: "UDID", value: ctx.udid, inline: true },
            { name: "Duration", value: `${Date.now() - ctx.startMs}ms`, inline: true },
          ],
        },
        ...embeds,
      ],
    })
  )

  const res = await fetch(webhookUrl, { method: "POST", body: form })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Discord webhook failed (${res.status}): ${text}`)
  }
}

function parseDiscordScreenshotMode(args: string[]): DiscordScreenshotMode {
  const mode = parseFlag(args, "discord-screenshots")
  if (!mode) return "failure"
  const normalized = mode.trim().toLowerCase()
  if (normalized === "none" || normalized === "failure" || normalized === "important") {
    return normalized as DiscordScreenshotMode
  }
  throw new Error("Invalid --discord-screenshots. Use: none | failure | important")
}

function pickDiscordScreenshots(
  ctx: RunContext,
  mode: DiscordScreenshotMode,
  ok: boolean
): Array<{ path: string; reason: string }> {
  if (mode === "none") return []
  if (mode === "important") return ctx.importantShots.slice(0, 4)
  if (ok) return []
  return ctx.importantShots.slice(0, 4)
}

function buildVideoConfig(runDir: string, args: string[], webhook?: string): VideoConfig {
  const enabledByFlag = hasFlag(args, "record-video") || hasFlag(args, "video")
  const disabledByFlag = hasFlag(args, "no-video")
  const enabled = !disabledByFlag && (enabledByFlag || Boolean(webhook))
  const maxVideoMb = Number(parseFlag(args, "max-video-mb") || "24")
  const maxBytes = Number.isFinite(maxVideoMb) && maxVideoMb > 0
    ? Math.floor(maxVideoMb * 1024 * 1024)
    : DEFAULT_MAX_VIDEO_BYTES
  return {
    enabled,
    rawPath: join(runDir, "run.raw.mp4"),
    compressedPath: join(runDir, "run.mp4"),
    maxBytes,
  }
}

async function startRunVideoCapture(udid: string, config: VideoConfig): Promise<VideoCapture | null> {
  if (!config.enabled) return null

  const proc = Bun.spawn(
    ["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", config.rawPath],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )

  await sleep(250)
  return { proc, rawPath: config.rawPath }
}

async function stopRunVideoCapture(capture: VideoCapture | null): Promise<void> {
  if (!capture) return
  try {
    capture.proc.kill("SIGINT")
  } catch {}
  await capture.proc.exited
}

async function compressVideoFast(rawPath: string, outputPath: string, maxBytes: number): Promise<string | null> {
  if (!existsSync(rawPath)) return null
  const hasFfmpeg = await commandExists("ffmpeg")
  if (!hasFfmpeg) return rawPath

  const duration = await getVideoDurationSec(rawPath)
  const safeBudgetBytes = Math.floor(maxBytes * 0.9)
  const targetBitrateKbps = duration
    ? Math.max(220, Math.floor((safeBudgetBytes * 8) / duration / 1000))
    : 1200

  const attempts: Array<{ scale: string; crf: string; bitrateKbps: number }> = [
    { scale: "trunc(iw*0.75/2)*2:trunc(ih*0.75/2)*2", crf: "33", bitrateKbps: targetBitrateKbps },
    { scale: "trunc(iw*0.6/2)*2:trunc(ih*0.6/2)*2", crf: "36", bitrateKbps: Math.max(180, Math.floor(targetBitrateKbps * 0.75)) },
    { scale: "trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2", crf: "38", bitrateKbps: Math.max(150, Math.floor(targetBitrateKbps * 0.6)) },
  ]

  let bestPath: string | null = null
  let bestSize = Number.POSITIVE_INFINITY

  for (const attempt of attempts) {
    const res = await runBestEffortCommand(
      [
        "ffmpeg",
        "-y",
        "-i",
        rawPath,
        "-an",
        "-r",
        "30",
        "-vf",
        attempt.scale,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        attempt.crf,
        "-b:v",
        `${attempt.bitrateKbps}k`,
        "-maxrate",
        `${attempt.bitrateKbps}k`,
        "-bufsize",
        `${Math.max(300, attempt.bitrateKbps * 2)}k`,
        "-movflags",
        "+faststart",
        outputPath,
      ],
      120_000
    )

    if (!res.ok || !existsSync(outputPath)) continue
    const size = fileSizeBytes(outputPath)
    if (size > 0 && size < bestSize) {
      bestPath = outputPath
      bestSize = size
    }
    if (size > 0 && size <= maxBytes) {
      return outputPath
    }
  }

  // Final fallback: keep 30fps, simple transform for maximum compatibility.
  const fallback = await runBestEffortCommand(
    [
      "ffmpeg",
      "-y",
      "-i",
      rawPath,
      "-an",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "38",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    120_000
  )

  if (fallback.ok && existsSync(outputPath)) {
    const size = fileSizeBytes(outputPath)
    if (size > 0 && size <= maxBytes) return outputPath
    if (size > 0 && size < bestSize) {
      bestPath = outputPath
      bestSize = size
    }
  }

  if (bestPath && bestSize <= fileSizeBytes(rawPath)) return bestPath
  return rawPath
}

async function acquireLock(agent: string, udid: string, timeoutMs: number): Promise<{ ticketId: string }> {
  ensureDir(QUEUE_DIR)
  ensureDir(DEVICE_HOME)

  const ticketId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const ticket: QueueTicket = {
    ticketId,
    agent,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  }
  const ticketPath = join(QUEUE_DIR, `${ticketId}-${agent}.json`)
  writeFileSync(ticketPath, `${JSON.stringify(ticket, null, 2)}\n`)

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    clearDeadTickets()
    clearStaleLock()

    const queue = readQueueTickets()
    const head = queue[0]
    if (head === basename(ticketPath)) {
      try {
        mkdirSync(LOCK_DIR)
        const lock: LockInfo = {
          agent,
          pid: process.pid,
          ticketId,
          createdAt: new Date().toISOString(),
          udid,
        }
        writeFileSync(join(LOCK_DIR, "info.json"), `${JSON.stringify(lock, null, 2)}\n`)
        rmSync(ticketPath, { force: true })
        return { ticketId }
      } catch {
        // Another process got lock first; keep waiting.
      }
    }

    await sleep(250)
  }

  rmSync(ticketPath, { force: true })
  throw new Error("Timed out waiting for simulator lock")
}

function releaseLock(agent?: string) {
  const info = readLockInfo()
  if (!info) return
  if (agent && info.agent !== agent) {
    throw new Error(`Lock is owned by agent ${info.agent}, not ${agent}`)
  }
  rmSync(LOCK_DIR, { recursive: true, force: true })
}

function runStatus() {
  clearStaleLock()
  clearDeadTickets()
  const info = readLockInfo()
  const queue = readQueueTickets().map((name) => readTicket(join(QUEUE_DIR, name)))
  console.log(
    JSON.stringify(
      {
        lock: info,
        queue: queue.map((item) => ({ ticketId: item.ticketId, agent: item.agent, createdAt: item.createdAt, pid: item.pid })),
      },
      null,
      2
    )
  )
}

async function runAcquire(args: string[], timeoutMs: number) {
  const agent = parseFlag(args, "agent")
  if (!agent) throw new Error("Usage: hotline device acquire --agent <id> [--udid <udid>] [--timeout <ms>]")
  const udid = await resolveUdid(args, timeoutMs)
  const lock = await acquireLock(agent, udid, timeoutMs)
  console.log(JSON.stringify({ ok: true, agent, udid, ticketId: lock.ticketId }))
}

function runRelease(args: string[]) {
  const agent = parseFlag(args, "agent")
  releaseLock(agent)
  console.log(JSON.stringify({ ok: true, released: true }))
}

async function runAct(args: string[], globals: DeviceGlobals) {
  const agent = parseFlag(args, "agent")
  const action = args[1]
  if (!agent || !action) {
    throw new Error("Usage: hotline device act <action> --agent <id> [action flags]")
  }

  const udid = await resolveUdid(args, globals.timeout)
  await acquireLock(agent, udid, globals.timeout)

  const runId = formatNow()
  const runDir = join(parseFlag(args, "runs-dir") || DEFAULT_RUNS_DIR, agent, runId)
  ensureDir(runDir)

  const ctx: RunContext = {
    agent,
    bundleId: parseFlag(args, "bundleId") || parseFlag(args, "bundle") || globals.appId,
    appId: parseFlag(args, "appId") || globals.appId,
    udid,
    runId,
    runDir,
    startMs: Date.now(),
    port: globals.port,
    defaultTimeoutMs: globals.timeout,
    importantShots: [],
    steps: [],
  }

  try {
    const step: DeviceStep = { type: action }
    switch (action) {
      case "tap":
        step.x = toNumber(parseFlag(args, "x"), "x")
        step.y = toNumber(parseFlag(args, "y"), "y")
        break
      case "type":
        step.text = parseFlag(args, "text") || ""
        break
      case "swipe":
      case "scroll":
        step.x1 = toNumber(parseFlag(args, "x1"), "x1")
        step.y1 = toNumber(parseFlag(args, "y1"), "y1")
        step.x2 = toNumber(parseFlag(args, "x2"), "x2")
        step.y2 = toNumber(parseFlag(args, "y2"), "y2")
        break
      case "launch":
      case "reset":
      case "reset-app":
        step.bundleId = parseFlag(args, "bundleId") || parseFlag(args, "bundle") || globals.appId
        break
      case "simctl": {
        const sep = args.indexOf("--")
        if (sep === -1 || sep === args.length - 1) throw new Error("simctl action requires `-- <simctl args>`")
        step.args = args.slice(sep + 1)
        break
      }
      case "wait-event":
        step.event = parseFlag(args, "event")
        step.appId = parseFlag(args, "appId") || globals.appId
        break
      case "sleep":
        step.ms = toNumber(parseFlag(args, "ms") || "250", "ms")
        break
      case "screenshot":
      case "record":
        break
      default:
        throw new Error(`Unsupported action: ${action}`)
    }

    if (hasFlag(args, "important")) step.important = true

    await executeStep(ctx, step, 0)
    const finalShot = await captureStepScreenshot(ctx, "final", "final state")
    markImportant(ctx, finalShot, "final state")

    const output = {
      ok: true,
      agent,
      action,
      udid,
      runDir,
      steps: ctx.steps,
      importantShots: ctx.importantShots,
    }

    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(output, null, 2)}\n`)
    console.log(JSON.stringify(output, null, 2))
  } finally {
    releaseLock(agent)
  }
}

async function runScript(args: string[], globals: DeviceGlobals) {
  const agent = parseFlag(args, "agent")
  const scriptPath = parseFlag(args, "script")
  if (!agent || !scriptPath) {
    throw new Error("Usage: hotline device run --agent <id> --script <steps.json> [--udid <udid>]")
  }

  const runsDir = parseFlag(args, "runs-dir") || DEFAULT_RUNS_DIR
  const issuesDir = parseFlag(args, "issues-dir") || DEFAULT_ISSUES_DIR
  const webhook = parseFlag(args, "discord-webhook") || process.env.HOTLINE_DEVICE_DISCORD_WEBHOOK
  const similarity = Number(parseFlag(args, "issue-threshold") || "0.82")
  const defaultTimeoutMs = Number(parseFlag(args, "action-timeout") || String(globals.timeout))
  const discordScreenshotMode = parseDiscordScreenshotMode(args)

  const script = parseScript(scriptPath)
  const udid = await resolveUdid(args, globals.timeout)
  await acquireLock(agent, udid, globals.timeout)

  const runId = formatNow()
  const runDir = join(runsDir, agent, runId)
  ensureDir(runDir)
  const videoConfig = buildVideoConfig(runDir, args, webhook)

  const ctx: RunContext = {
    agent,
    bundleId: script.bundleId || parseFlag(args, "bundleId") || globals.appId,
    appId: script.appId || parseFlag(args, "appId") || globals.appId,
    udid,
    runId,
    runDir,
    startMs: Date.now(),
    port: globals.port,
    defaultTimeoutMs,
    importantShots: [],
    steps: [],
  }

  let summary = script.summary || "Device run completed"
  let videoCapture: VideoCapture | null = null
  let videoForWebhook: string | null = null

  try {
    videoCapture = await startRunVideoCapture(udid, videoConfig)

    for (let i = 0; i < script.steps.length; i++) {
      await executeStep(ctx, script.steps[i], i)
    }

    const finalShot = await captureStepScreenshot(ctx, "final", "final success")
    markImportant(ctx, finalShot, "final success")
    await stopRunVideoCapture(videoCapture)
    videoCapture = null
    videoForWebhook = await compressVideoFast(videoConfig.rawPath, videoConfig.compressedPath, videoConfig.maxBytes)
    if (videoForWebhook && fileSizeBytes(videoForWebhook) > videoConfig.maxBytes) {
      summary = `${summary}\nVideo omitted from webhook (size over ${Math.floor(videoConfig.maxBytes / 1024 / 1024)}MB limit).`
      videoForWebhook = null
    }

    const output = {
      ok: true,
      runId,
      runDir,
      udid,
      video: videoForWebhook,
      steps: ctx.steps,
      importantShots: ctx.importantShots,
    }

    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(output, null, 2)}\n`)

    if (webhook) {
      const screenshots = pickDiscordScreenshots(ctx, discordScreenshotMode, true)
      await postDiscordSummary(webhook, ctx, true, summary, videoForWebhook || undefined, screenshots)
    }

    console.log(JSON.stringify(output, null, 2))
  } catch (error: any) {
    await stopRunVideoCapture(videoCapture)
    videoCapture = null
    videoForWebhook = await compressVideoFast(videoConfig.rawPath, videoConfig.compressedPath, videoConfig.maxBytes)
    if (videoForWebhook && fileSizeBytes(videoForWebhook) > videoConfig.maxBytes) {
      summary = `${summary}\nVideo omitted from webhook (size over ${Math.floor(videoConfig.maxBytes / 1024 / 1024)}MB limit).`
      videoForWebhook = null
    }

    const message = error?.message || String(error)
    const stepFailure = ctx.steps.find((step) => !step.ok)
    const memory = searchIssueMemory(`${summary}\n${message}`, similarity)

    if (!memory) {
      addIssueMemory(issuesDir, summary, message, runId)
    }

    summary = memory
      ? `Matched prior issue (${memory.score.toFixed(3)}): ${memory.hit.summary}`
      : `No similar issue found. Recorded new issue memory.`

    const output = {
      ok: false,
      runId,
      runDir,
      udid,
      error: message,
      failedStep: stepFailure,
      memoryHit: memory
        ? {
            score: Number(memory.score.toFixed(4)),
            id: memory.hit.id,
            file: memory.hit.file,
            summary: memory.hit.summary,
          }
        : null,
      video: videoForWebhook,
      steps: ctx.steps,
      importantShots: ctx.importantShots,
    }

    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(output, null, 2)}\n`)

    if (webhook) {
      const screenshots = pickDiscordScreenshots(ctx, discordScreenshotMode, false)
      await postDiscordSummary(webhook, ctx, false, `${summary}\nError: ${message}`, videoForWebhook || undefined, screenshots)
    }

    console.log(JSON.stringify(output, null, 2))
    process.exit(1)
  } finally {
    await stopRunVideoCapture(videoCapture)
    releaseLock(agent)
  }
}

async function runSimctl(args: string[], globals: DeviceGlobals) {
  const agent = parseFlag(args, "agent")
  const sep = args.indexOf("--")
  if (!agent || sep === -1 || sep === args.length - 1) {
    throw new Error("Usage: hotline device simctl --agent <id> -- <simctl args>")
  }
  const rawArgs = args.slice(sep + 1)
  const udid = await resolveUdid(args, globals.timeout)

  await acquireLock(agent, udid, globals.timeout)
  try {
    const rewritten = rawArgs.map((arg) => (arg === "booted" ? udid : arg))
    const { out, err } = await runCommand(["xcrun", "simctl", ...rewritten], globals.timeout)
    console.log(JSON.stringify({ ok: true, out: out.trim(), err: err.trim(), udid }))
  } finally {
    releaseLock(agent)
  }
}

function usage(): never {
  console.error(`hotline device - serialized simulator actions

Commands:
  hotline device status
  hotline device acquire --agent <id> [--udid <udid>] [--timeout <ms>]
  hotline device release [--agent <id>]
  hotline device run --agent <id> --script <steps.json> [--discord-webhook <url>] [--video|--record-video] [--max-video-mb <n>] [--discord-screenshots <none|failure|important>]
  hotline device act <action> --agent <id> [action flags]
  hotline device simctl --agent <id> -- <simctl args>

Actions:
  tap --x <n> --y <n>
  type --text <value>
  swipe --x1 <n> --y1 <n> --x2 <n> --y2 <n>
  launch --bundleId <id>
  reset --bundleId <id>
  screenshot
  record [--seconds <n>]
  wait-event --event <name> [--appId <id>]
  sleep --ms <n>
  simctl -- <args>
`)
  process.exit(1)
}

export async function runDeviceCommand(args: string[], globals: DeviceGlobals) {
  const sub = args[0]
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") usage()

  const timeoutMs = Number(parseFlag(args, "timeout") || String(globals.timeout))

  switch (sub) {
    case "status":
      runStatus()
      return
    case "acquire":
      await runAcquire(args, timeoutMs)
      return
    case "release":
      runRelease(args)
      return
    case "run":
      await runScript(args, globals)
      return
    case "act":
      await runAct(args, globals)
      return
    case "simctl":
      await runSimctl(args, globals)
      return
    default:
      usage()
  }
}
