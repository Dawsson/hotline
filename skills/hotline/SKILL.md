---
name: hotline
description: Integrate hotline into a React Native or Expo app. Hotline is a local WebSocket dev bridge that lets CLI tools and AI agents send commands to and query data from running apps in real time.
license: MIT
compatibility: Requires bun, React Native or Expo project
metadata:
  author: Dawsson
  version: "0.3.2"
---

# Hotline Setup

Integrate hotline into this Expo/React Native app. Hotline is a local WebSocket dev bridge that lets CLI tools and AI agents send commands to and query data from the running app.

## Steps

1. Add the hotline dependency: `bun add @dawsson/hotline`

2. Create a `HotlineProvider` component at `providers/HotlineProvider.tsx` (or the appropriate providers directory for this project). Use this exact pattern:

```tsx
import { useHotline } from "@dawsson/hotline/src/client"

export function HotlineProvider({ children }: { children: React.ReactNode }) {
  const hotline = useHotline({
    appId: "<bundle-id>", // use this app's actual bundle ID from app.json or app.config.ts
    handlers: {
      // Add handlers based on what this app supports (see below)
    },
  })

  return <>{children}</>
}
```

3. Wrap the app's root layout with `<HotlineProvider>`. Place it inside any existing providers (navigation, state, etc.) so handlers can access app state.

4. Register handlers. Every handler uses `{ handler, fields, description }` format so it advertises its schema to `hotline watch` and agents.

## Standard Handlers

**State access** — if the app uses any state management (zustand, redux, context, etc.):
```ts
"get-state": {
  handler: ({ key }) => store.getState()[key],
  fields: [{ name: "key", type: "string", description: "State key to fetch" }],
  description: "Get a value from app state",
}
```

**Navigation** — if the app uses expo-router or react-navigation:
```ts
"navigate": {
  handler: ({ screen, params }) => router.push(screen),
  fields: [
    { name: "screen", type: "string", description: "Screen name or path" },
    { name: "params", type: "json", optional: true, description: "Navigation params" },
  ],
  description: "Navigate to a screen",
}
```

**Get current route:**
```ts
"get-route": {
  handler: () => pathname,
  description: "Get the current route",
}
```

Add any custom app-specific handlers using the same `{ handler, fields, description }` format.

## Events

Apps can emit events for agents to wait on:

```ts
hotline.emit("navigation", { screen: pathname })
hotline.emit("error", { message: error.message })
```

Agents block on events with `hotline wait <event>`:
```bash
hotline cmd navigate --screen /checkout
hotline wait navigation
hotline cmd get-state --key cart
```

## Important Details

- **appId must match the bundle identifier** from app.json / app.config.ts
- **Production safe** — `useHotline` is a no-op when `__DEV__` is false
- **Auto-reconnects** with exponential backoff (1s to 30s cap)
- **Server runs on port 8675** — install with `hotline setup` (macOS launchd)
- Import path is `@dawsson/hotline/src/client`
- All handlers must use `{ handler, fields, description }` — no bare functions
- `ping` is handled automatically

## Verifying

After integrating, with the app running:
```bash
hotline status
hotline cmd ping
hotline cmd get-state --key user
hotline watch
```

## Agent Automation Pattern

After writing code that triggers a hot reload:
```bash
hotline wait-for-app
hotline wait error --timeout 3000 || true
hotline cmd get-state --key <key>
```
