import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs"
import { DEFAULT_PORT, LAUNCHD_LABEL, PLIST_PATH, LOG_FILE, PID_DIR } from "./types"

function generatePlist(port: number): string {
  const bunPath = Bun.which("bun") || "/usr/local/bin/bun"
  const serverPath = new URL("./server.ts", import.meta.url).pathname

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOTLINE_PORT</key>
    <string>${port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>`
}

export async function setup(port: number = DEFAULT_PORT) {
  mkdirSync(PID_DIR, { recursive: true })

  const plist = generatePlist(port)
  writeFileSync(PLIST_PATH, plist)
  console.error(`Wrote ${PLIST_PATH}`)

  const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  await proc.exited

  console.error(`Loaded ${LAUNCHD_LABEL}`)
}

export async function teardown() {
  if (existsSync(PLIST_PATH)) {
    const proc = Bun.spawn(["launchctl", "unload", PLIST_PATH], {
      stdio: ["inherit", "inherit", "inherit"],
    })
    await proc.exited

    unlinkSync(PLIST_PATH)
    console.error(`Removed ${PLIST_PATH}`)
  } else {
    console.error("No launchd service found.")
  }
}
