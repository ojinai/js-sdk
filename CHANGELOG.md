# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-04-23

`1.0.0` is the first Node-only, server-side release of the Ojin TypeScript SDK.
The SDK is intended to run in your own Node.js backend, keep Ojin credentials on
the server, and forward video/audio frames to your frontend over your own
transport. Direct browser-to-Ojin WebSocket usage is withdrawn from this release.

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

### Removed

- `receiveMessage()`.
- `startInteraction()`.
- The browser-direct WebSocket path from the v0.1 scope. v1.0 does not support
  loading this SDK in browsers, React Native, or other untrusted runtimes.
- The browser-facing `unsafe_createClientWithApiKey` path that was discussed in
  the pre-pivot plan but is not part of the Node-only v1.0 release.

### Fixed

- `D2` Outbound and inbound messages are split into distinct hierarchies, so
  `sendMessage()` can no longer accept server-only message classes that never
  worked at runtime. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D3` Event delivery is now the only response path; the duplicated polling
  queue is gone. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D5` Node heartbeat configuration was added so long-lived backend connections
  can send client-originated WebSocket pings. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D6` `waitForReady()` plus the bounded pre-ready outgoing queue close the gap
  between `connect()` resolving and `session.ready` arriving. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D8` SDK logging now flows through an injectable logger rather than scattered
  raw `console.*` calls in `src/`. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D12` `startInteraction()` was removed along with the duplicate response
  queue. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D13` Server error codes are mapped into typed SDK errors so integrators can
  branch on auth, rate limit, timeout, backend availability, and related
  conditions. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D14` The pending resolver leak disappeared with the removal of the
  `receiveMessage()` queueing path. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D15` Plain-text server failures are surfaced as `ProtocolError` with the raw
  message attached instead of being silently lost. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)
- `D17` The event emitter routes handler failures through the injected logger
  instead of `console.error`. [PR #TBD](https://github.com/journee-live/ojin/pull/TBD)

Items explicitly superseded by the Node-only scope change rather than fixed by
code in v1.0:

- `D1` Browser auth failure is superseded because the browser-direct path was
  removed from the release.
- `D18` Default-entry tree-shaking pressure is superseded as a release blocker by
  the Node-only scope; the `./profiling` subpath remains as API-surface hygiene.
- `D19` `unsafe_createClientWithApiKey` warning semantics are superseded because
  that browser-facing factory is not shipped in this release.

### Breaking changes

The list below tracks the v0.1 -> v1.0 breaking surface, with the shipped repo
surface taking precedence over earlier draft designs.

1. `sendMessage()` now accepts outbound messages only.

```ts
// v0.1
client.sendMessage(anyOjinMessage);

// v1.0
client.sendMessage(outboundClientMessage);
```

2. `toProxyMessage()` was renamed to `toMessage()` on outbound message classes.

```ts
// v0.1
const payload = message.toProxyMessage();

// v1.0
const payload = message.toMessage();
```

3. Legacy reconnect and queue options were renamed and guarded at construction.

```ts
// v0.1
const client = new OjinClient({
  wsUrl,
  apiKey,
  configId,
  reconnectDelay: 1,
  reconnectAttempts: 3,
  maxPendingOutgoing: 100,
});

// v1.0
const client = new OjinClient({
  wsUrl,
  apiKey,
  configId,
  initialConnectAttempts: 3,
  initialConnectDelayMs: 500,
  maxReconnectAttempts: 5,
  reconnectBackoff: {
    initialMs: 500,
    maxMs: 30_000,
    multiplier: 2,
    jitter: 0.3,
  },
  outgoingQueue: {
    maxMessages: 100,
    onOverflow: "reject",
  },
});
```

4. `autoWaitForReady` defaults to `false`, so sends before `session.ready` now
   throw unless you opt into buffering.

```ts
// v0.1
await client.sendMessage(message);

// v1.0
await client.sendMessage(message);
// If you want buffering instead of a throw:
// new OjinClient({ ..., autoWaitForReady: true })
```

5. `receiveMessage()` and `startInteraction()` were removed; events are the only
   inbound delivery path.

```ts
// v0.1
await client.startInteraction();
const message = await client.receiveMessage();

// v1.0
client.events.on(OjinEvent.InteractionResponse, (message) => {
  handleResponse(message);
});
```

6. Earlier draft designs included a future `session.closed` object payload
   `{ code, reason, disconnectReason }`, but the current repo still ships
   `OjinEvent.ConnectionClosed` as a two-argument callback. Use the exported
   event constant and the current callback shape below.

```ts
import { OjinEvent } from "ojin-client";

client.events.on(OjinEvent.ConnectionClosed, (code, reason) => {
  handleDisconnect({ code, reason });
});
```

7. Earlier draft designs also included a public simplification from
   `Uint8Array<ArrayBuffer>` to plain `Uint8Array`. Runtime behavior is
   unchanged, but the current repo still carries some
   `Uint8Array<ArrayBuffer>` protocol-class types, so do not rely on that draft
   simplification when migrating existing code.

### Scope change: v1.0 is Node-only

The headline change for v1.0 is the 2026-04-21 scope pivot: browser-direct
usage of the Ojin WebSocket is out of scope for this release.

- Keep the SDK in your Node.js backend.
- Keep `apiKey` and other Ojin credentials on the server.
- Expose your own client-facing transport from your backend to your frontend.
- Defer browser-native Ojin connectivity until the backend offers a proper
  media-transport ingress such as WebRTC, LiveKit, or Daily.

Reference pattern:
- [README backend pattern](README.md)
- [Forward frames to a downstream client transport](docs/recipes/forward-frames-to-client.md)

### Migration guide

#### Renamed options

- `reconnectDelay` -> `reconnectBackoff.initialMs`
  Rationale: the old field was ambiguous and measured in seconds; the new field
  is explicit and uses milliseconds so the SDK can reject the old name instead
  of silently introducing a 1000x timing bug.
- `reconnectAttempts` -> `initialConnectAttempts` and `maxReconnectAttempts`
  Rationale: the old field collapsed two different failure modes into one name.
  v1.0 separates "first connect" retries from "unexpected live-drop" retries.
- `maxPendingOutgoing` -> `outgoingQueue.maxMessages`
  Rationale: the nested name makes the queue direction explicit and leaves room
  for overflow policy under the same `outgoingQueue` object.
- `maxQueuedMessages` -> `outgoingQueue.maxMessages`
  Rationale: same queue-shape normalization as above; one bounded outbound queue
  surface instead of multiple legacy flat aliases.

#### Migrating off the browser-direct path

If you previously bundled the SDK into a browser app, move that integration into
your own backend and forward frames to the client over your own transport.

```ts
// v1.0 backend-side pattern
import { OjinClient, OjinEvent } from "ojin-client";

const client = new OjinClient({
  wsUrl: process.env.OJIN_WS_URL!,
  apiKey: process.env.OJIN_API_KEY!,
  configId: process.env.OJIN_CONFIG_ID!,
});

client.events.on(OjinEvent.InteractionResponse, (msg) => {
  downstream.send({
    interactionId: msg.interactionId,
    video: msg.videoFrameBytes,
    audio: msg.audioFrameBytes,
    isFinal: msg.isFinalResponse,
  });
});
```

For a complete handoff example, see
[docs/recipes/forward-frames-to-client.md](docs/recipes/forward-frames-to-client.md).

#### Migrating the ConnectionClosed listener

Use the exported event constant from the current repo surface. If you were
tracking the draft plan, note that the object payload with `disconnectReason`
did not land in the current tree.

```ts
// older code
client.events.on("connectionClosed", (code, reason) => {
  cleanup(code, reason);
});

// current v1.0 surface
import { OjinEvent } from "ojin-client";

client.events.on(OjinEvent.ConnectionClosed, (code, reason) => {
  cleanup(code, reason);
});
```

#### Migrating from receiveMessage / startInteraction

Replace the old polling loop with event-driven response handling.

```ts
// v0.1
await client.startInteraction();
while (true) {
  const message = await client.receiveMessage();
  if (!message) break;
  handleResponse(message);
}

// v1.0
import { OjinClient, OjinEvent } from "ojin-client";

const client = new OjinClient({
  wsUrl,
  apiKey,
  configId,
});

client.events.on(OjinEvent.InteractionResponse, (message) => {
  handleResponse(message);
});

await client.connect();
await client.waitForReady();
await client.sendText("Hello from the backend");
await client.endInteraction();
```
