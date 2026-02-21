import { existsSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"

type CommandPayload = {
  command: "swipe" | "tap" | "type" | "drag" | "shutdown"
  appBundleId?: string
  direction?: "up" | "down" | "left" | "right"
  x?: number
  y?: number
  x2?: number
  y2?: number
  durationMs?: number
  text?: string
}

const RUNNER_PROJECT = join(process.cwd(), "ios-runner", "AgentDeviceRunner", "AgentDeviceRunner.xcodeproj")
const DERIVED = join(process.env.HOME || ".", ".hotline", "xctest-runner", "derived")

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function randomPort(): number {
  return 62000 + Math.floor(Math.random() * 3000)
}

async function runCommand(cmd: string[], timeoutMs: number): Promise<{ out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => {
    try { proc.kill("SIGKILL") } catch {}
  }, timeoutMs)
  const [code, out, err] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.trim() || out.trim()}`)
  return { out, err }
}

function findXctestrunFile(): string | null {
  const products = join(DERIVED, "Build", "Products")
  if (!existsSync(products)) return null
  const files = readdirSync(products).filter((f) => f.endsWith(".xctestrun") && !f.includes("env.session"))
  if (files.length === 0) return null
  files.sort()
  return join(products, files[files.length - 1])
}

async function ensureBuilt(udid: string) {
  if (findXctestrunFile()) return
  ensureDir(DERIVED)
  await runCommand(
    [
      "xcodebuild",
      "build-for-testing",
      "-project",
      RUNNER_PROJECT,
      "-scheme",
      "AgentDeviceRunner",
      "-destination",
      `platform=iOS Simulator,id=${udid}`,
      "-derivedDataPath",
      DERIVED,
    ],
    240_000
  )
}

async function waitForPortReady(logPath: string, timeoutMs: number): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(logPath)) {
      const txt = await Bun.file(logPath).text()
      const match = txt.match(/AGENT_DEVICE_RUNNER_PORT=(\d+)/)
      if (match) {
        const parsed = Number(match[1])
        if (Number.isFinite(parsed) && parsed > 0) return parsed
      }
      if (txt.includes("TEST FAILED") || txt.includes("xcodebuild: error")) {
        throw new Error(`xctest runner failed to start: ${txt.slice(-800)}`)
      }
    }
    await Bun.sleep(200)
  }
  throw new Error("Timed out waiting for xctest runner port")
}

async function sendRunnerCommand(port: number, body: CommandPayload) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`runner http ${res.status}`)
  const payload = (await res.json()) as { ok: boolean; error?: { message?: string } }
  if (!payload.ok) throw new Error(payload.error?.message || "runner command failed")
}

export async function runXctestCommand(udid: string, command: CommandPayload): Promise<void> {
  if (!existsSync(RUNNER_PROJECT)) {
    throw new Error(`Missing local runner project: ${RUNNER_PROJECT}`)
  }

  await ensureBuilt(udid)
  const xctestrun = findXctestrunFile()
  if (!xctestrun) throw new Error("xctestrun file not found after build")

  const requestedPort = randomPort()
  const logPath = join(DERIVED, `runner-${process.pid}-${Date.now()}.log`)

  const proc = Bun.spawn(
    [
      "xcodebuild",
      "test-without-building",
      "-only-testing",
      "AgentDeviceRunnerUITests/RunnerTests/testCommand",
      "-parallel-testing-enabled",
      "NO",
      "-test-timeouts-enabled",
      "NO",
      "-maximum-concurrent-test-simulator-destinations",
      "1",
      "-xctestrun",
      xctestrun,
      "-destination",
      `platform=iOS Simulator,id=${udid}`,
    ],
    {
      env: { ...process.env, AGENT_DEVICE_RUNNER_PORT: String(requestedPort) },
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath),
      stdin: "ignore",
    }
  )

  try {
    const actualPort = await waitForPortReady(logPath, 25_000)
    await sendRunnerCommand(actualPort, command)
    await sendRunnerCommand(actualPort, { command: "shutdown" })
    const exit = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => -1)])
    if (exit === -1) {
      try { proc.kill("SIGKILL") } catch {}
      throw new Error("xctest runner did not exit")
    }
  } finally {
    if (proc.exitCode == null) {
      try { proc.kill("SIGKILL") } catch {}
    }
  }
}
