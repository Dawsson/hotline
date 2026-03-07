# Agent Usage

How to use hotline from the CLI or as an AI agent to interact with a running React Native app.

## CLI Commands

| Command | Description |
|---------|-------------|
| `hotline cmd <type> [--key val]` | Send command to app |
| `hotline query <key>` | Shorthand for `get-state` |
| `hotline wait <event>` | Block until app emits event, print payload |
| `hotline wait-for-app [appId]` | Block until an app connects |
| `hotline watch` | Interactive TUI (browse apps, commands, live events) |
| `hotline watch --passive` | Stream-only mode (CI/scripting) |
| `hotline status` | Show connected apps |
| `hotline device <subcommand>` | Serialized simulator automation for agents |

**Flags:** `--port <N>` (default 8675) `--timeout <ms>` (default 5000) `--app <appId>` `--device <id>` `--udid <id>` `--connection <id>`

**Output:** stdout = JSON data only (pipeable). stderr = logs/errors.

## Sending Commands

Inline args (auto-coerces types):

```bash
hotline cmd get-state --key currentUser
hotline cmd navigate --screen /settings
hotline cmd add-to-cart --productId abc123 --quantity 2
```

JSON payload:

```bash
hotline cmd get-state --payload '{"key":"user"}'
```

## Querying State

Shorthand for `get-state`:

```bash
hotline query currentUser
hotline query cart
```

## Multi-App Targeting

When multiple apps are connected, use `--app` to target a specific one:

```bash
hotline cmd ping --app com.example.myapp
hotline cmd get-state --key auth --app com.example.otherapp
```

If only one app is connected, `--app` is optional — it auto-selects.

## Multi-Simulator Targeting

When multiple copies of the same app are connected, `--app` is not enough. Use the simulator identity instead:

```bash
hotline status
hotline cmd ping --udid F1B2C3D4-...
hotline wait error --udid F1B2C3D4-... --timeout 3000 || true
hotline ls --udid F1B2C3D4-...
```

Recommended pattern:
- register each app connection with `target.deviceId` set to the real simulator UDID
- use `--udid` from agents because it lines up with iOS simulator tooling
- reserve `--connection` for one exact live socket when you need to disambiguate reconnects

## Automation Pattern

After writing code that triggers a hot reload:

```bash
hotline wait-for-app --udid <sim-udid>            # block until that simulator reconnects
hotline wait error --udid <sim-udid> --timeout 3000 || true
hotline cmd get-state --key <key> --udid <sim-udid>
```

## Chaining Commands

Navigate then verify:

```bash
hotline cmd navigate --screen /checkout
hotline wait navigation                     # block until navigation fires
hotline cmd get-state --key cart            # check state after navigation
```

## Interactive Mode

`hotline watch` opens a TUI where you can:
- Browse connected apps
- See available commands with their schemas
- Fill in fields and send commands
- See live events streaming in

`hotline watch --passive` is stream-only (good for CI logs or piping).

## Device Automation

Use `hotline device` when multiple agents need one shared simulator (serialized execution).

```bash
hotline device status
hotline device run --agent agent-1 --script ./steps.json --discord-webhook "$WEBHOOK"
hotline device act tap --agent agent-1 --x 320 --y 640
hotline device simctl --agent agent-1 -- ui booted appearance dark
```

`hotline device run` captures screenshots after each step and auto-records/compresses/sends a run video when a webhook is set. Discord screenshot uploads default to failure-only.
