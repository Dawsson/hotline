# Changelog

All notable changes to this project will be documented in this file.

## [0.3.4] - 2026-02-17

- Added `--version` flag to CLI

## [0.3.3] - 2026-02-17

- Made `wait-for-app` smart: detects if app is already connected and returns immediately, otherwise waits for connection
- Various README polish and documentation improvements

## [0.3.2] - 2025-12-17

- Added `hotline wait-for-app` command to block until an app connects
- Updated documentation for new commands and handler schema format
- Polished README and package.json for public release

## [0.3.1] - 2025-12-10

- Fixed interactive watch mode to fall back to `list-apps` on older servers

## [0.3.0] - 2025-12-09

- Added event system: apps can emit events via `hotline.emit()` and listen on the server
- Added `hotline wait <event>` command to block until app emits specific event
- Added schema-aware inline args for `hotline cmd` (auto type coercion)
- Simplified CLI arg parsing

## [0.2.0] - 2025-11-28

- Changed handler format to use `{ handler, fields, description }` objects (breaking change)
- Handlers with bare functions are no longer supported; use schemas instead
- Improved handler schema protocol for command advertisement

## [0.1.0] - 2025-11-15

- Initial release
- Local WebSocket dev bridge for React Native apps
- Multi-app support with targeted command routing
- Interactive command browser with `hotline watch`
- macOS launchd integration for background server
- React Native client library with hooks and event system
