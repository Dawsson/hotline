# Hotline

Local WebSocket dev bridge for React Native apps. Lets CLI tools and AI agents send commands to and query data from running apps.

## Development

- **Run `bun test` often** — Type-check and run tests after any code change. Don't skip this.
- **`bunx tsc --noEmit`** — Run after edits to catch type errors early
- **Server is on port 8675** — Already running via launchd, don't start it manually
- **Don't start dev servers** — API (3001) and Web (3000) are already running

## Architecture

- `src/types.ts` — Protocol types (requests, responses, events, handler schemas)
- `src/client.ts` — App-side client (`createHotline`, `useHotline` React hook)
- `src/server.ts` — WebSocket server (routing, handler registry, event broadcast)
- `src/cli.ts` — CLI entry point (`hotline cmd`, `hotline wait`, `hotline watch`, etc.)
- `src/interactive.ts` — Interactive TUI for `hotline watch`
- `src/launchd.ts` — macOS launchd service management

## Key Concepts

### Handler Schema Format
All handlers use `{ handler, fields, description }` — no bare functions. This is required so schemas are advertised to `hotline watch` and agents.

```ts
"get-state": {
  handler: ({ key }) => store.getState()[key],
  fields: [{ name: "key", type: "string", description: "State key" }],
  description: "Read from app state",
}
```

### Events
Apps emit events via `hotline.emit("event-name", data)`. These are fire-and-forget pushes to the server, which broadcasts to watchers and delivers to any `hotline wait` listeners.

### CLI Commands
- `hotline cmd <type> --key value` — Inline args (auto-coerces types)
- `hotline wait <event>` — Blocks until app emits matching event, prints payload, exits
- `hotline wait-for-app [appId]` — Blocks until an app connects (use after hot reload)
- `hotline watch` — Interactive TUI (app/command browser + live stream)
- `hotline watch --passive` — Stream-only mode (CI/scripting)
- `hotline restart` — Kill server and let launchd relaunch with new code

## Publishing

1. Bump version in `package.json`
2. `bun publish --access public`
3. After publishing, update the global `/setup-hotline` command if the API changed

## After Making Changes

When modifying hotline's protocol or API:
1. Run `bun test` and `bunx tsc --noEmit`
2. **Always update `~/.claude/CLAUDE.md`** — Keep the global Hotline section in sync with new commands, flags, and patterns. This is what all agents across all projects see.
3. Update `~/.claude/commands/setup-hotline.md` if the client API or handler format changed
