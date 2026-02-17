# Events

Events are fire-and-forget messages from the app to the server. The server broadcasts them to all watchers and delivers them to any `hotline wait` listeners.

## Emitting Events

From inside the app, use `hotline.emit()`:

```ts
// Navigation changes
hotline.emit("navigation", { screen: pathname })

// Errors
hotline.emit("error", { message: error.message, stack: error.stack })

// UI state changes
hotline.emit("bottom-sheet", { id: "settings", visible: true })

// Custom app events
hotline.emit("order-placed", { orderId: "abc123", total: 49.99 })
```

Events are pushed in real time over WebSocket — no polling.

## Listening for Events

From the CLI, use `hotline wait` to block until a specific event fires:

```bash
hotline wait navigation           # blocks until "navigation" event, prints payload
hotline wait error --timeout 3000 # wait up to 3s for an error (timeout = no error)
hotline wait order-placed         # wait for a custom event
```

`hotline wait` prints the event payload as JSON to stdout and exits.

## Common Patterns

### Verify navigation completed

```bash
hotline cmd navigate --screen /checkout
hotline wait navigation
# prints: {"screen":"/checkout"}
```

### Check for crashes after hot reload

```bash
hotline wait-for-app
hotline wait error --timeout 3000 || true
# exit 0 = no crash, exit 1 = error event received
```

### Stream all events

```bash
hotline watch --passive
# prints every event as it happens (good for CI logs)
```

## Tips

- Events are broadcast to all connected watchers, not just the first one
- `hotline wait` exits after receiving the first matching event
- Use `--timeout` to avoid hanging forever (default is 5000ms)
- Event names are arbitrary strings — use whatever makes sense for your app
