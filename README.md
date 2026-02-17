# hotline

Local WebSocket dev bridge for React Native apps. Send commands and query state from CLI tools, AI agents, or test frameworks — with multi-app support.

```bash
npx skills add Dawsson/hotline
```

> Installs hotline as an [agent skill](https://skills.sh) — works with Claude Code, Cursor, Windsurf, and other AI agents. Once installed, your agent can automatically integrate hotline into any React Native project.

```
Agent A ──┐                          ┌── App "com.foo" (Simulator 1)
Agent B ──┤── ws://localhost:8675 ──┤── App "com.bar" (Simulator 2)
Agent C ──┘     (relay server)       └── App "com.foo" (Simulator 3)
```

Port 8675 — the first four digits of 867-5309.

## Install

```bash
bun add @dawsson/hotline
```

## App Setup

```tsx
import { useHotline } from "@dawsson/hotline/src/client"

function App() {
  const hotline = useHotline({
    appId: "com.example.myapp",
    handlers: {
      "get-state": {
        handler: ({ key }) => store.getState()[key],
        fields: [{ name: "key", type: "string", description: "State key" }],
        description: "Read from app state",
      },
      "navigate": {
        handler: ({ screen }) => navigation.navigate(screen),
        fields: [{ name: "screen", type: "string", description: "Screen name" }],
        description: "Navigate to a screen",
      },
    },
  })

  return <YourApp />
}
```

Or without the hook:

```ts
import { createHotline } from "@dawsson/hotline/src/client"

const hotline = createHotline({
  appId: "com.example.myapp",
  handlers: { /* ... */ },
})

hotline.connect()
```

The client automatically reconnects with exponential backoff and no-ops in production (`__DEV__` guard).

## CLI

| Command | Description |
|---------|-------------|
| `hotline cmd <type> [--key val]` | Send command to app |
| `hotline query <key>` | Shorthand for `get-state` |
| `hotline wait <event>` | Block until app emits event, print payload |
| `hotline wait-for-app [appId]` | Block until an app connects |
| `hotline watch` | Interactive TUI (browse apps, commands, live events) |
| `hotline watch --passive` | Stream-only mode (CI/scripting) |
| `hotline status` | Show connected apps |
| `hotline start [--daemon]` | Start server (foreground or background) |
| `hotline stop` | Stop daemonized server |
| `hotline restart` | Kill and relaunch (picks up new code) |
| `hotline setup` | Install macOS launchd service |
| `hotline teardown` | Remove launchd service |
| `hotline logs` | Tail server log file |

**Flags:** `--port <N>` (default 8675) `--timeout <ms>` (default 5000) `--app <appId>`

**Output:** stdout = JSON data only (pipeable). stderr = logs/errors.

## Handler Format

All handlers use `{ handler, fields, description }` — no bare functions. This lets the TUI and agents discover available commands.

```ts
"get-state": {
  handler: ({ key }) => store.getState()[key],
  fields: [{ name: "key", type: "string", description: "State key" }],
  description: "Read from app state",
}
```

## Events

Apps push events to the server, which broadcasts to all watchers:

```ts
hotline.emit("navigation", { screen: "Home" })
hotline.emit("error", { message: "Something broke" })
```

## Agent Automation

After writing code that triggers a hot reload:

```bash
hotline wait-for-app                        # block until app reconnects
hotline wait error --timeout 3000 || true   # check for crashes
hotline cmd get-state --key currentUser     # verify state
```

## Protocol

JSON over WebSocket. Every request has a unique UUID `id`.

```jsonc
// Request (CLI → Server → App)
{ "id": "uuid", "type": "get-state", "payload": { "key": "user" } }

// Response (App → Server → CLI)
{ "id": "uuid", "ok": true, "data": { "name": "Dawson" } }
```

## License

MIT
