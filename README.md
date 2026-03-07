# hotline

Let agents talk to your React Native and Expo apps.

```
Agent ──┐                            ┌── App (Simulator 1)
CLI   ──┤── ws://localhost:8675 ────┤── App (Simulator 2)
Tests ──┘                            └── App (Device)
```

## Install

### With AI

Add the [skill](https://skills.sh) to your agent, then tell it to set up hotline:

```bash
npx skills add Dawsson/hotline
```

Then in your AI agent's chat:

```
Set up hotline in this project
```

It will install the package, create the provider, register handlers, and wire everything up for you.

### Manual

```bash
bun add @dawsson/hotline
```

Add the hook to your app and register handlers:

```tsx
import { useHotline } from "@dawsson/hotline/src/client"

function App() {
  useHotline({
    appId: "com.example.myapp",
    target: {
      deviceId: "F1B2C3D4-...", // ideally the simulator UDID on iOS
      deviceName: "iPhone 17 Pro",
      platform: "ios",
    },
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

When you run the same app on multiple simulators, set `target.deviceId` to a real simulator identity such as the iOS simulator UDID. `appId` stays the bundle identifier, but routing should use the simulator identity.

## CLI

```bash
hotline cmd get-state --key currentUser   # send a command
hotline query user                        # shorthand for get-state
hotline wait navigation                   # block until event fires
hotline wait-for-app --udid F1B2C3D4-...  # block until a specific simulator connects
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
