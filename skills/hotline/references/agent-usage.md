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

**Flags:** `--port <N>` (default 8675) `--timeout <ms>` (default 5000) `--app <appId>`

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

## Automation Pattern

After writing code that triggers a hot reload:

```bash
hotline wait-for-app                        # block until app reconnects
hotline wait error --timeout 3000 || true   # check for crashes (timeout = no crash)
hotline cmd get-state --key <key>           # verify state
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
