# Integrating Hotline into a Swift / SwiftUI App

No npm package needed. The Swift client is implemented directly in the project — copy the `HotlineClient.swift` file below and wire it into your app.

## Protocol Overview

- Connect to `ws://localhost:8675`
- On open: send a `register` message with your `appId` and handler schemas
- Receive: `{ id, type, payload? }` — dispatch to a handler, respond with `{ id, ok, data }` or `{ id, ok: false, error }`
- Emit events: `{ type: "event", event, data? }`
- `ping` must be handled explicitly (no automatic built-in like the JS client)
- **DEBUG only** — wrap `connect()` in `#if DEBUG` so it's a no-op in release builds

## Step 1 — Add HotlineClient.swift

Copy this file into your Xcode project (add it to your target's compile sources):

```swift
import Foundation

/// Hotline dev bridge — connects to ws://localhost:8675 and handles CLI commands.
/// Only active in DEBUG builds. Lets AI agents and CLI tools control the app in real time.
@MainActor
final class HotlineClient: ObservableObject {
    // Set this to your app's bundle ID
    static let appId = "com.example.myapp"
    private static let port = 8675
    private static let reconnectCap: TimeInterval = 30

    @Published private(set) var isConnected = false

    // Callbacks — wired by your root view in .onAppear (or AppDelegate)
    // Add whatever makes sense for your app's state
    var onGetState: ((_ key: String) -> Any?)?
    var onSetState: ((_ key: String, _ value: Any) -> Void)?
    var onNavigate: ((_ screen: String) -> Void)?
    var getCurrentRoute: (() -> String?)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var delegate: Delegate?
    private var reconnectWork: DispatchWorkItem?
    private var intentionalClose = false
    private var reconnectDelay: TimeInterval = 1

    func connect() {
        #if DEBUG
        intentionalClose = false
        doConnect()
        #endif
    }

    func disconnect() {
        intentionalClose = true
        reconnectWork?.cancel()
        reconnectWork = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
        delegate = nil
        isConnected = false
    }

    /// Emit an event — agents waiting with `hotline wait <event>` receive this
    func emit(_ event: String, data: [String: Any]? = nil) {
        var payload: [String: Any] = ["type": "event", "event": event]
        if let data { payload["data"] = data }
        sendRaw(payload)
    }

    // MARK: - Private

    private func doConnect() {
        guard !intentionalClose else { return }
        guard let url = URL(string: "ws://localhost:\(Self.port)") else { return }

        let del = Delegate()
        del.onOpen = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isConnected = true
                self.reconnectDelay = 1
                self.sendRegistration()
            }
        }
        del.onClose = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.intentionalClose else { return }
                self.isConnected = false
                self.task = nil
                self.session = nil
                self.delegate = nil
                self.scheduleReconnect()
            }
        }
        delegate = del

        let sess = URLSession(
            configuration: .default,
            delegate: del,
            delegateQueue: OperationQueue.main
        )
        session = sess
        let ws = sess.webSocketTask(with: url)
        task = ws
        ws.resume()
        listenForMessages(ws)
    }

    private func sendRegistration() {
        // Declare every handler here so `hotline ls` shows the schema
        sendRaw([
            "type": "register",
            "role": "app",
            "appId": Self.appId,
            "handlers": [
                makeHandler("ping", description: "Health check"),
                makeHandler(
                    "get-state",
                    description: "Get a value from app state",
                    fields: [makeField("key", type: "string", description: "State key")]
                ),
                makeHandler(
                    "set-state",
                    description: "Set a value in app state",
                    fields: [
                        makeField("key", type: "string", description: "State key"),
                        makeField("value", type: "json", description: "New value"),
                    ]
                ),
                makeHandler(
                    "navigate",
                    description: "Navigate to a screen",
                    fields: [makeField("screen", type: "string", description: "Screen name or path")]
                ),
                makeHandler("get-route", description: "Get the current route"),
            ] as [[String: Any]],
        ])
    }

    private func listenForMessages(_ ws: URLSessionWebSocketTask) {
        ws.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, !self.intentionalClose, self.task === ws else { return }
                switch result {
                case .success(let message):
                    self.handleMessage(message)
                    self.listenForMessages(ws)
                case .failure:
                    self.isConnected = false
                    self.task = nil
                    self.session = nil
                    self.delegate = nil
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let d): data = d
        @unknown default: return
        }
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = json["id"] as? String,
            let type = json["type"] as? String
        else { return }
        dispatchCommand(id: id, type: type, payload: json["payload"] as? [String: Any] ?? [:])
    }

    private func dispatchCommand(id: String, type: String, payload: [String: Any]) {
        switch type {
        case "ping":
            respond(id: id, data: [:])

        case "get-state":
            guard let key = payload["key"] as? String else {
                respondError(id: id, error: "key is required")
                return
            }
            let value = onGetState?(key)
            respond(id: id, data: ["key": key, "value": value as Any])

        case "set-state":
            guard let key = payload["key"] as? String else {
                respondError(id: id, error: "key is required")
                return
            }
            if let value = payload["value"] {
                onSetState?(key, value)
                respond(id: id, data: ["key": key])
            } else {
                respondError(id: id, error: "value is required")
            }

        case "navigate":
            guard let screen = payload["screen"] as? String else {
                respondError(id: id, error: "screen is required")
                return
            }
            onNavigate?(screen)
            respond(id: id, data: ["screen": screen])

        case "get-route":
            respond(id: id, data: ["route": getCurrentRoute?() as Any])

        default:
            respondError(id: id, error: "Unknown command: \(type)")
        }
    }

    private func respond(id: String, data: [String: Any]) {
        sendRaw(["id": id, "ok": true, "data": data])
    }

    private func respondError(id: String, error: String) {
        sendRaw(["id": id, "ok": false, "error": error])
    }

    private func sendRaw(_ payload: [String: Any]) {
        guard
            let ws = task,
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let text = String(data: data, encoding: .utf8)
        else { return }
        ws.send(.string(text)) { _ in }
    }

    private func scheduleReconnect() {
        guard !intentionalClose else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, Self.reconnectCap)
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor [weak self] in self?.doConnect() }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func makeHandler(_ type: String, description: String, fields: [[String: Any]]? = nil) -> [String: Any] {
        var h: [String: Any] = ["type": type, "description": description]
        if let fields { h["fields"] = fields }
        return h
    }

    private func makeField(_ name: String, type: String, description: String, optional: Bool = false) -> [String: Any] {
        var f: [String: Any] = ["name": name, "type": type, "description": description]
        if optional { f["optional"] = true }
        return f
    }
}

// MARK: - WebSocket delegate (non-isolated — runs on OperationQueue.main)

private final class Delegate: NSObject, URLSessionWebSocketDelegate {
    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onClose?()
    }
}
```

## Step 2 — Wire into your app

### SwiftUI root view

```swift
struct ContentView: View {
    @StateObject private var hotline = HotlineClient()

    var body: some View {
        // your content...
    }
    .onAppear {
        // Wire state callbacks before connecting
        hotline.onGetState = { key in
            // return your app state for the given key
            AppState.shared.value(for: key)
        }
        hotline.onSetState = { key, value in
            AppState.shared.setValue(value, for: key)
        }
        hotline.onNavigate = { screen in
            NavigationRouter.shared.navigate(to: screen)
        }
        hotline.getCurrentRoute = {
            NavigationRouter.shared.currentScreen
        }
        hotline.connect()
    }
}
```

### UIKit AppDelegate

```swift
class AppDelegate: UIResponder, UIApplicationDelegate {
    let hotline = HotlineClient()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions ...) -> Bool {
        hotline.onGetState = { key in /* ... */ }
        hotline.connect()
        return true
    }
}
```

## Step 3 — Register custom handlers

Add any app-specific commands in `sendRegistration()` and a matching `case` in `dispatchCommand()`:

```swift
// In sendRegistration():
makeHandler(
    "add-to-cart",
    description: "Add a product to the cart",
    fields: [
        makeField("productId", type: "string", description: "Product ID"),
        makeField("quantity", type: "number", description: "Quantity", optional: true),
    ]
),

// In dispatchCommand():
case "add-to-cart":
    guard let productId = payload["productId"] as? String else {
        respondError(id: id, error: "productId is required")
        return
    }
    let quantity = payload["quantity"] as? Int ?? 1
    Cart.shared.add(productId, quantity: quantity)
    respond(id: id, data: ["productId": productId, "quantity": quantity])
```

## Step 4 — Emit events

Call `hotline.emit()` anywhere in the app when something interesting happens:

```swift
// After navigation
hotline.emit("navigation", data: ["screen": currentScreen])

// After a purchase
hotline.emit("purchase", data: ["productId": id, "status": "success"])

// On error
hotline.emit("error", data: ["message": error.localizedDescription])
```

Agents block on events with `hotline wait <event>`.

## Important Details

- **`appId` must match the bundle identifier** — e.g. `com.example.myapp` from your Xcode project settings
- **DEBUG only** — `connect()` is wrapped in `#if DEBUG` and is a no-op in release builds
- **Auto-reconnects** with exponential backoff (1s → 30s cap) when the server restarts
- **Server runs on port 8675** — started via `hotline setup` (macOS launchd, auto-starts on login)
- **No third-party dependencies** — uses `URLSessionWebSocketTask` (iOS 13+)
- **`ping` must be handled** — unlike the JS client, there's no automatic built-in; add the `ping` case in `dispatchCommand`
- Use `delegateQueue: OperationQueue.main` so the `Delegate` callbacks fire on the main thread safely

## Xcode Project File

When adding `HotlineClient.swift` manually, you must register it in `project.pbxproj`. Add entries in three sections:

```
/* PBXFileReference */
AA000000000000000000000A /* HotlineClient.swift */ = {isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = sourcecode.swift; path = HotlineClient.swift; sourceTree = "<group>"; };

/* PBXBuildFile */
BB000000000000000000000B /* HotlineClient.swift in Sources */ = {isa = PBXBuildFile; fileRef = AA000000000000000000000A /* HotlineClient.swift */; };

/* PBXGroup — add inside the App group children */
AA000000000000000000000A /* HotlineClient.swift */,

/* PBXSourcesBuildPhase — add to the Sources files list */
BB000000000000000000000B /* HotlineClient.swift in Sources */,
```

Use unique 24-character hex IDs (uppercase) for `AA...` and `BB...`.

## Verifying

With the app running in a simulator:

```bash
hotline status                              # shows bundle ID when connected
hotline cmd ping --app com.example.myapp   # should return ok
hotline cmd get-route --app com.example.myapp
hotline watch --app com.example.myapp      # interactive TUI
```
