# Device Automation

`hotline device` provides serialized iOS simulator control for multiple agents sharing one simulator.

## Core Model

- One global simulator lock at a time
- Many agents can enqueue work
- Every action captures a screenshot into `runs/<agent>/<timestamp>/`
- Optional failure memory in local `issues/`

## Commands

```bash
hotline device status
hotline device acquire --agent <id>
hotline device release --agent <id>
hotline device run --agent <id> --script <steps.json>
hotline device act <action> --agent <id> [flags]
hotline device simctl --agent <id> -- <simctl args>
```

## Fast Video + Webhook

`hotline device run` can auto-record and upload run video.

- Auto-enabled when `--discord-webhook` is provided
- Or force with `--record-video` / `--video`
- Disable with `--no-video`
- Video is compressed for speed (`ffmpeg` ultrafast) at `30 FPS`
- Webhook upload is size-limited (default `24MB` safety budget for Discord's `25MB` cap)
- Override cap with `--max-video-mb <n>`
- Screenshot uploads default to `failure` mode (none on success, important shots on failure)
- Override with `--discord-screenshots none|failure|important`

```bash
hotline device run \
  --agent qa-1 \
  --script ./steps.json \
  --discord-webhook "$DISCORD_WEBHOOK" \
  --max-video-mb 24 \
  --discord-screenshots failure
```

## Steps JSON

```json
{
  "summary": "Smoke test login and home",
  "bundleId": "com.example.app",
  "steps": [
    { "type": "launch", "important": true, "note": "Launch app" },
    { "type": "sleep", "ms": 1200 },
    { "type": "tap", "x": 320, "y": 740, "note": "Tap Login" },
    { "type": "type", "text": "qa@example.com" },
    { "type": "swipe", "x1": 320, "y1": 1000, "x2": 320, "y2": 350 },
    { "type": "wait-event", "event": "navigation", "appId": "com.example.app" },
    { "type": "screenshot", "important": true, "note": "Final state" }
  ]
}
```

## Supported Step Types

- `tap` requires `x`, `y`
- `type` requires `text`
- `swipe` requires `x1`, `y1`, `x2`, `y2`
- `launch` uses `bundleId` from step or top-level script
- `reset` / `reset-app` uses `bundleId`
- `screenshot`
- `record` optional `seconds`
- `simctl` requires `args` array
- `wait-event` requires `event`, optional `appId`
- `sleep` optional `ms`

Optional on any step:
- `important: true` (marks screenshot for webhook summary)
- `note` (recorded in run JSON)
- `timeoutMs` (overrides default action timeout)

## Output Artifacts

Per run:
- `run.json` structured result and timing
- `step-*.png` per-step screenshots
- `final.png` final screenshot
- `run.raw.mp4` raw recording (if enabled)
- `run.mp4` compressed recording (if compression succeeds)

## Input Reliability Notes

On newer Xcode builds where `simctl io` does not expose tap/swipe/text, hotline falls back to UI-driving via `cliclick` + Simulator window mapping.
