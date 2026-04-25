# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0-rc] - 2026-04-23

`1.0.0-rc` is the first server-side release candidate of the Ojin TypeScript SDK.
The SDK is intended to run in your own Node.js backend, keep Ojin credentials on
the server, and forward video/audio frames to your frontend over your own
transport.

### Added

- `waitForReady()` for the post-connect warm-up phase before the server starts
  accepting interactions.
- Optional pre-ready buffering with `autoWaitForReady`, `waitForReadyTimeoutMs`,
  and `outgoingQueue.{maxMessages,onOverflow}`.
- `OjinEvent.WaitingForReady` and `OjinEvent.QueueOverflow` for ready-state and
  bounded-queue observability.
- Typed server and SDK error coverage, including `AuthError`,
  `RateLimitError`, `BackendUnavailableError`, `ReadyTimeoutError`,
  `QueueFullError`, and `AudioLockedError`.
- `sendText()`, `sendAudio()`, `interrupt()`, and `endInteraction()` convenience
  helpers on `OjinClient`.
- `sendTextTurn()` as the one-call helper for a complete text interaction.
- `sendTextTurnAndWait()` for the high-level "send text and wait for the final response" flow.
- `streamTextTurn()` for the high-level "send text and stream frames for just that turn" flow.
- Node heartbeat support via `heartbeatIntervalMs`.
- `./profiling` and `./protocol` package subpath exports.

### Changed

- The public SDK story is now explicitly Node/server-only. Documentation,
  recipes, and examples all assume `frontend -> your backend -> Ojin`.
- `sendMessage()` is typed for outbound `OjinClientMessage` subclasses rather
  than the old mixed client/server message surface.
- Client message serialization uses `toMessage()` for the logical payload shape;
  the old `toProxyMessage()` name is gone from outbound message classes and was
  removed from inbound-only classes that never had a valid outbound wire form.
- Constructor migration guards now fail loudly on legacy option names instead of
  silently aliasing ambiguous or unsafe values.
- Error handling now preserves server codes such as `AUTH_FAILED`,
  `BACKEND_UNAVAILABLE`, `RATE_LIMITED`, and `FRAME_SIZE_EXCEEDED` instead of
  collapsing everything into coarse transport failures.
- The default behavior remains "throw if the server is not ready"; consumers who
  want implicit buffering must opt back in with `autoWaitForReady: true`.
