import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { type Subprocess } from "bun"
import type { HotlineRequest, HotlineResponse } from "./types"

// ── Helpers ──

const TEST_PORT = 9675 // avoid colliding with real server

function startServer(): Promise<Subprocess> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
      env: { ...process.env, HOTLINE_PORT: String(TEST_PORT) },
      stdout: "ignore",
      stderr: "pipe",
    })

    // Wait for "listening" log line
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    let buf = ""

    function read() {
      reader.read().then(({ done, value }) => {
        if (done) return reject(new Error("Server exited before ready"))
        buf += decoder.decode(value)
        if (buf.includes("listening")) {
          reader.releaseLock()
          resolve(proc)
        } else {
          read()
        }
      })
    }
    read()

    setTimeout(() => reject(new Error("Server start timeout")), 5000)
  })
}

function stopServer(proc: Subprocess) {
  proc.kill("SIGTERM")
  return proc.exited
}

/** Open a WebSocket and wait for it to be ready */
function openWs(role: "cli" | "watch" | "app", appTarget?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let url = `ws://localhost:${TEST_PORT}?role=${role}`
    if (appTarget) url += `&app=${encodeURIComponent(appTarget)}`
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(e)
    setTimeout(() => reject(new Error("WS connect timeout")), 3000)
  })
}

/** Register as an app on an existing WebSocket */
function registerApp(ws: WebSocket, appId: string, handlers?: any[]) {
  const msg: any = { type: "register", role: "app", appId }
  if (handlers) msg.handlers = handlers
  ws.send(JSON.stringify(msg))
}

/** Send a request and wait for a matching response */
function request(ws: WebSocket, type: string, payload?: Record<string, unknown>): Promise<HotlineResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const msg: HotlineRequest = { id, type }
    if (payload) msg.payload = payload

    const handler = (event: MessageEvent) => {
      const res = JSON.parse(String(event.data))
      if (res.id === id) {
        ws.removeEventListener("message", handler)
        resolve(res)
      }
    }
    ws.addEventListener("message", handler)
    ws.send(JSON.stringify(msg))

    setTimeout(() => {
      ws.removeEventListener("message", handler)
      reject(new Error(`Request timeout: ${type}`))
    }, 5000)
  })
}

/** Wait for the next message on a WebSocket */
function nextMessage(ws: WebSocket, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      ws.removeEventListener("message", handler)
      resolve(JSON.parse(String(event.data)))
    }
    ws.addEventListener("message", handler)
    setTimeout(() => {
      ws.removeEventListener("message", handler)
      reject(new Error("nextMessage timeout"))
    }, timeout)
  })
}

/** Small delay for message propagation */
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))

function closeWs(ws: WebSocket | null) {
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
}

// ── Tests ──

let serverProc: Subprocess

beforeAll(async () => {
  serverProc = await startServer()
})

afterAll(async () => {
  await stopServer(serverProc)
})

// Track all sockets so we can clean up after each test
let sockets: WebSocket[] = []

function trackWs(ws: WebSocket) {
  sockets.push(ws)
  return ws
}

afterEach(() => {
  for (const ws of sockets) closeWs(ws)
  sockets = []
})

// ── Server builtins ──

describe("server built-in commands", () => {
  test("ping", async () => {
    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "ping")
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({})
  })

  test("list-apps with no apps connected", async () => {
    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "list-apps")
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      port: TEST_PORT,
      apps: [],
    })
    expect(typeof (res.data as any).pid).toBe("number")
    expect(typeof (res.data as any).uptime).toBe("number")
  })

  test("list-apps shows connected app", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.myapp")
    await tick()

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "list-apps")
    expect(res.ok).toBe(true)

    const data = res.data as any
    expect(data.apps).toHaveLength(1)
    expect(data.apps[0].appId).toBe("com.test.myapp")
    expect(typeof data.apps[0].connectedAt).toBe("number")
  })

  test("list-handlers returns registered handlers", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.app", [
      { type: "get-state", description: "Get state", fields: [{ name: "key", type: "string" }] },
    ])
    await tick()

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "list-handlers")
    expect(res.ok).toBe(true)

    const data = res.data as any[]
    expect(data).toHaveLength(1)
    expect(data[0].appId).toBe("com.test.app")
    expect(data[0].handlers).toHaveLength(1)
    expect(data[0].handlers[0].type).toBe("get-state")
  })
})

// ── Request routing ──

describe("CLI → App request routing", () => {
  test("routes request to single connected app and receives response", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.echo")
    await tick()

    // App echoes back payload
    app.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        app.send(JSON.stringify({ id: msg.id, ok: true, data: { echo: msg.payload } }))
      }
    }

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "do-thing", { foo: "bar" })
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ echo: { foo: "bar" } })
  })

  test("error response from app is forwarded", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.err")
    await tick()

    app.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        app.send(JSON.stringify({ id: msg.id, ok: false, error: "something broke" }))
      }
    }

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "fail-cmd")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("something broke")
  })

  test("no app connected returns error", async () => {
    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "some-cmd")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("No app connected")
  })

  test("routes to targeted app with --app", async () => {
    const app1 = trackWs(await openWs("app"))
    registerApp(app1, "com.test.alpha")
    const app2 = trackWs(await openWs("app"))
    registerApp(app2, "com.test.beta")
    await tick()

    // Only app1 responds
    app1.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        app1.send(JSON.stringify({ id: msg.id, ok: true, data: { from: "alpha" } }))
      }
    }

    const cli = trackWs(await openWs("cli", "com.test.alpha"))
    const res = await request(cli, "who-are-you")
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ from: "alpha" })
  })

  test("multiple apps without --app returns ambiguous error", async () => {
    const app1 = trackWs(await openWs("app"))
    registerApp(app1, "com.test.one")
    const app2 = trackWs(await openWs("app"))
    registerApp(app2, "com.test.two")
    await tick()

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "some-cmd")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("Multiple apps")
    expect(res.error).toContain("com.test.one")
    expect(res.error).toContain("com.test.two")
  })

  test("targeting non-existent app returns error", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.real")
    await tick()

    const cli = trackWs(await openWs("cli", "com.test.ghost"))
    const res = await request(cli, "hello")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("No app connected with id: com.test.ghost")
  })
})

// ── Watch mode ──

describe("watch mode", () => {
  test("watcher receives app registration events", async () => {
    const watcher = trackWs(await openWs("watch"))
    const msgPromise = nextMessage(watcher)

    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.watched")

    const event = await msgPromise
    expect(event.dir).toBe("req")
    expect(event.appId).toBe("com.test.watched")
    expect(event.msg.type).toBe("register")
  })

  test("watcher receives request and response events", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.w2")
    await tick()

    app.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        app.send(JSON.stringify({ id: msg.id, ok: true, data: { pong: true } }))
      }
    }

    const watcher = trackWs(await openWs("watch"))
    const events: any[] = []
    watcher.onmessage = (e) => events.push(JSON.parse(String(e.data)))

    const cli = trackWs(await openWs("cli"))
    await request(cli, "test-ping", { v: 1 })

    await tick(30)

    // Should have received request + response events
    const reqEvent = events.find((e) => e.dir === "req" && e.msg?.type === "test-ping")
    const resEvent = events.find((e) => e.dir === "res")
    expect(reqEvent).toBeDefined()
    expect(reqEvent.appId).toBe("com.test.w2")
    expect(resEvent).toBeDefined()
    expect(resEvent.msg.ok).toBe(true)
  })

  test("watcher receives disconnect events", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.disc")
    await tick()

    const watcher = trackWs(await openWs("watch"))
    const msgPromise = nextMessage(watcher)

    app.close()
    const event = await msgPromise
    expect(event.msg.type).toBe("disconnect")
    expect(event.appId).toBe("com.test.disc")
  })
})

// ── App disconnect handling ──

describe("app disconnect", () => {
  test("pending requests fail when app disconnects", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.dc")
    await tick()

    // App receives request but never responds — then disconnects
    app.onmessage = () => {
      // intentionally ignore - then close
      setTimeout(() => app.close(), 50)
    }

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "slow-cmd")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("App disconnected")
  })
})

// ── Multiple concurrent requests ──

describe("concurrent requests", () => {
  test("handles multiple in-flight requests to same app", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.multi")
    await tick()

    // App responds with the type it received, with a small delay for variety
    app.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        setTimeout(() => {
          app.send(JSON.stringify({ id: msg.id, ok: true, data: { type: msg.type } }))
        }, Math.random() * 20)
      }
    }

    const cli = trackWs(await openWs("cli"))

    const [r1, r2, r3] = await Promise.all([
      request(cli, "cmd-a"),
      request(cli, "cmd-b"),
      request(cli, "cmd-c"),
    ])

    expect(r1.ok).toBe(true)
    expect((r1.data as any).type).toBe("cmd-a")
    expect(r2.ok).toBe(true)
    expect((r2.data as any).type).toBe("cmd-b")
    expect(r3.ok).toBe(true)
    expect((r3.data as any).type).toBe("cmd-c")
  })

  test("handles requests from multiple CLI clients simultaneously", async () => {
    const app = trackWs(await openWs("app"))
    registerApp(app, "com.test.multicli")
    await tick()

    app.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && msg.type) {
        app.send(JSON.stringify({ id: msg.id, ok: true, data: msg.payload }))
      }
    }

    const cli1 = trackWs(await openWs("cli"))
    const cli2 = trackWs(await openWs("cli"))
    const cli3 = trackWs(await openWs("cli"))

    const [r1, r2, r3] = await Promise.all([
      request(cli1, "cmd", { from: "cli1" }),
      request(cli2, "cmd", { from: "cli2" }),
      request(cli3, "cmd", { from: "cli3" }),
    ])

    expect(r1.data).toEqual({ from: "cli1" })
    expect(r2.data).toEqual({ from: "cli2" })
    expect(r3.data).toEqual({ from: "cli3" })
  })
})

// ── Client library (createHotline) ──

describe("createHotline client", () => {
  test("connects, registers, and handles commands", async () => {
    // Dynamically import to avoid React dep issues
    const { createHotline } = await import("./client")

    let handlerCalled = false
    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.client-lib",
      handlers: {
        greet: { handler: (payload: any) => {
          handlerCalled = true
          return { greeting: `Hello, ${payload.name}!` }
        }},
      },
    })

    hotline.connect()
    await tick(50) // wait for connect + register

    // Verify app shows up
    const cli = trackWs(await openWs("cli"))
    const listRes = await request(cli, "list-apps")
    const apps = (listRes.data as any).apps
    expect(apps.some((a: any) => a.appId === "com.test.client-lib")).toBe(true)

    // Send command to the client library app
    const cliTargeted = trackWs(await openWs("cli", "com.test.client-lib"))
    const res = await request(cliTargeted, "greet", { name: "World" })
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ greeting: "Hello, World!" })
    expect(handlerCalled).toBe(true)

    hotline.disconnect()
  })

  test("handles async handlers", async () => {
    const { createHotline } = await import("./client")

    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.async-client",
      handlers: {
        "slow-op": { handler: async () => {
          await new Promise((r) => setTimeout(r, 10))
          return { done: true }
        }},
      },
    })

    hotline.connect()
    await tick(50)

    const cli = trackWs(await openWs("cli", "com.test.async-client"))
    const res = await request(cli, "slow-op")
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ done: true })

    hotline.disconnect()
  })

  test("handler errors return ok:false", async () => {
    const { createHotline } = await import("./client")

    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.err-client",
      handlers: {
        "will-fail": { handler: () => {
          throw new Error("handler exploded")
        }},
      },
    })

    hotline.connect()
    await tick(50)

    const cli = trackWs(await openWs("cli", "com.test.err-client"))
    const res = await request(cli, "will-fail")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("handler exploded")

    hotline.disconnect()
  })

  test("unknown command returns error", async () => {
    const { createHotline } = await import("./client")

    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.unknown-cmd",
    })

    hotline.connect()
    await tick(50)

    const cli = trackWs(await openWs("cli", "com.test.unknown-cmd"))
    const res = await request(cli, "nonexistent")
    expect(res.ok).toBe(false)
    expect(res.error).toContain("Unknown command")

    hotline.disconnect()
  })

  test("dynamically registered handler works", async () => {
    const { createHotline } = await import("./client")

    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.dynamic",
    })

    hotline.handle("added-later", { handler: () => ({ dynamic: true }) } as any)

    hotline.connect()
    await tick(50)

    const cli = trackWs(await openWs("cli", "com.test.dynamic"))
    const res = await request(cli, "added-later")
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ dynamic: true })

    hotline.disconnect()
  })

  test("built-in ping handler works", async () => {
    const { createHotline } = await import("./client")

    const hotline = createHotline({
      port: TEST_PORT,
      appId: "com.test.ping-client",
    })

    hotline.connect()
    await tick(50)

    const cli = trackWs(await openWs("cli", "com.test.ping-client"))
    const res = await request(cli, "ping")
    // Server handles ping before app, so this hits the server handler
    expect(res.ok).toBe(true)

    hotline.disconnect()
  })
})

// ── Edge cases ──

describe("edge cases", () => {
  test("invalid JSON is silently ignored", async () => {
    const cli = trackWs(await openWs("cli"))
    cli.send("not json at all {{{")
    await tick()
    // Server shouldn't crash — verify with a ping
    const res = await request(cli, "ping")
    expect(res.ok).toBe(true)
  })

  test("message without id/type is ignored", async () => {
    const cli = trackWs(await openWs("cli"))
    cli.send(JSON.stringify({ random: "data" }))
    await tick()
    const res = await request(cli, "ping")
    expect(res.ok).toBe(true)
  })

  test("multiple apps can register with same appId", async () => {
    const app1 = trackWs(await openWs("app"))
    registerApp(app1, "com.test.dupe")
    const app2 = trackWs(await openWs("app"))
    registerApp(app2, "com.test.dupe")
    await tick()

    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "list-apps")
    const apps = (res.data as any).apps
    const dupes = apps.filter((a: any) => a.appId === "com.test.dupe")
    expect(dupes.length).toBe(2)
  })

  test("rapid connect/disconnect cycles don't crash", async () => {
    for (let i = 0; i < 10; i++) {
      const ws = await openWs("cli")
      ws.close()
    }
    await tick()
    // Server still alive
    const cli = trackWs(await openWs("cli"))
    const res = await request(cli, "ping")
    expect(res.ok).toBe(true)
  })
})
