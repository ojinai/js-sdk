# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0-rc] - 2026-04-23

Initial public release candidate for `@ojinai/js-sdk`.

This release provides a server-side TypeScript SDK for connecting a Node.js
backend to the Ojin Speech-To-Video WebSocket service. Applications should keep
Ojin credentials on the server and expose their own frontend-facing transport.

### Added

- `OjinClient` for Node.js connection management, ready-state waiting, and
  event-driven response handling.
- Interaction helpers for text, audio, interruption, end-of-turn, one-shot text
  turns, and streaming text turns.
- Optional readiness buffering and bounded outgoing queue controls with
  `autoWaitForReady`, `waitForReadyTimeoutMs`, and `outgoingQueue`.
- Typed SDK and server errors, including auth, rate limit, backend availability,
  timeout, ready-timeout, and queue-full failures.
- Node WebSocket heartbeat support through `heartbeatIntervalMs`.
- Protocol message classes, serializers, and package subpath exports for
  `./protocol` and `./profiling`.
- ESM, CommonJS, and TypeScript declaration outputs for Node.js 20 and newer.
