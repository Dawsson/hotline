# Integrating Hotline into a Project

## Steps

1. Add the dependency:

```bash
bun add @dawsson/hotline
```

2. Create a `HotlineProvider` component at `providers/HotlineProvider.tsx` (or the appropriate providers directory for this project):

```tsx
import { useHotline } from "@dawsson/hotline/src/client"

export function HotlineProvider({ children }: { children: React.ReactNode }) {
  const hotline = useHotline({
    appId: "<bundle-id>", // use this app's actual bundle ID from app.json or app.config.ts
    target: {
      deviceId: "<simulator-udid>", // best for duplicate simulator routing
      deviceName: "iPhone 17 Pro",
      platform: "ios",
    },
    handlers: {
      // Add handlers based on what this app supports
      // See references/handlers.md for standard handlers
    },
  })

  return <>{children}</>
}
```

3. Wrap the app's root layout with `<HotlineProvider>`. Place it inside any existing providers (navigation, state, etc.) so handlers can access app state.

4. Register handlers using the `{ handler, fields, description }` format. See `references/handlers.md` for standard handlers.

## Without the Hook

For non-React contexts or manual control:

```ts
import { createHotline } from "@dawsson/hotline/src/client"

const hotline = createHotline({
  appId: "<bundle-id>",
  target: {
    deviceId: "<simulator-udid>",
    deviceName: "iPhone 17 Pro",
    platform: "ios",
  },
  handlers: { /* ... */ },
})

hotline.connect()
```

## Important Details

- **appId must match the bundle identifier** from app.json / app.config.ts (e.g. `com.example.myapp`)
- **Use `target.deviceId` for multi-simulator routing**. On iOS, this should be the simulator UDID when available.
- **Use `target.deviceName` only as a friendly label**. It is not unique enough for routing by itself.
- **Production safe** — `useHotline` is a no-op when `__DEV__` is false
- **Auto-reconnects** with exponential backoff (1s to 30s cap) if the server restarts
- **Server runs on port 8675** — install with `hotline setup` (macOS launchd)
- Import path is `@dawsson/hotline/src/client`
- `ping` is handled automatically — no need to register it

## Server Setup

The hotline server needs to be running on the dev machine:

```bash
hotline setup     # install as macOS launchd service (auto-starts on login)
hotline start     # or run manually in foreground
```

## Verifying

After integrating, with the app running in a simulator:

```bash
hotline status                                # should show the app's target identity
hotline cmd ping --udid <simulator-udid>      # should return ok
hotline cmd get-state --key user --udid <simulator-udid>
hotline watch                     # interactive TUI to browse and send commands
```
