# hotline

Local WebSocket dev bridge for React Native apps. Let AI agents send commands to and query state from your running app.

```bash
npx skills add Dawsson/hotline
```

Works with Claude Code, Cursor, Windsurf, and [other agents](https://skills.sh). Once installed, just ask your agent to integrate hotline — it handles the rest.

---

## How it works

Your app connects to a local WebSocket server. Agents and CLI tools send commands through it.

```
Agent ──┐                            ┌── App (Simulator 1)
CLI   ──┤── ws://localhost:8675 ────┤── App (Simulator 2)
Tests ──┘                            └── App (Device)
```

## Install

```bash
bun add @dawsson/hotline
```

## Setup

Add the hook to your app and register handlers:

```tsx
import { useHotline } from "@dawsson/hotline/src/client"

function App() {
  useHotline({
    appId: "com.example.myapp",
    handlers: {
      "get-state": {
        handler: ({ key }) => store.getState()[key],
        fields: [{ name: "key", type: "string", description: "State key" }],
        description: "Read from app state",
      },
    },
  })

  return <YourApp />
}
```

Auto-reconnects, no-ops in production, `ping` is built-in.

## CLI

```bash
hotline cmd get-state --key currentUser   # send a command
hotline query user                        # shorthand for get-state
hotline wait navigation                   # block until event fires
hotline wait-for-app                      # block until app connects
hotline watch                             # interactive TUI
```

## Events

Push real-time events from your app:

```ts
hotline.emit("navigation", { screen: "/home" })
hotline.emit("error", { message: "crash" })
```

## Server

```bash
hotline setup       # install as macOS launchd service
hotline start       # or run manually
```

## License

MIT
