# @ojinai/js-sdk — Ojin TypeScript SDK

Node.js / server-side SDK for the Ojin Speech-To-Video service. Connects to Ojin over WebSocket, delivers video and audio frames to your backend process, and lets you forward those frames through your own transport to your frontend. **Server-side only — not for use in browsers or mobile apps.**

## ⚠️ Not for client-side use

**Do not load this SDK in a browser, React Native app, or any other untrusted runtime.**

The Ojin WebSocket connection requires an API key on the upgrade request. Exposing that key in client-side code — or in a URL visible to the client — would leak the credential. The SDK ships as a Node.js package only; it relies on Node.js-native APIs that do not exist in browser runtimes.

The intended integration pattern is:

```
Your frontend  ⇄  Your backend (uses @ojinai/js-sdk)  ⇄  Ojin
```

Your backend opens the Ojin connection, owns the API key, and exposes your own transport (WebSocket, SSE, HTTP) to your frontend. Your frontend never touches Ojin directly.

Browser support is deferred until the Ojin backend ships a media-transport ingress (WebRTC / LiveKit / Daily).

## Install

```bash
npm install @ojinai/js-sdk
# or
pnpm add @ojinai/js-sdk
```

Requires Node.js ≥ 20.

## Quick Start

```ts
import { OjinClient, OjinEvent } from "@ojinai/js-sdk";

const client = new OjinClient({
  wsUrl: "wss://api.ojin.ai/ws",
  apiKey: process.env.OJIN_API_KEY!,   // never hardcode the key
  configId: process.env.OJIN_CONFIG_ID!,
});

// Session is ready — you can now send interactions.
client.events.on(OjinEvent.SessionReady, (msg) => {
  console.log("Session ready, params:", msg.parameters);
});

// Forward frames to your own client transport.
client.events.on(OjinEvent.InteractionResponse, (msg) => {
  myTransport.send({
    video: msg.videoFrameBytes,
    audio: msg.audioFrameBytes,
    frameType: msg.frameType,  // 0 = idle, 1 = speech
  });
});

// Session ended (client- or server-initiated, or after reconnect exhaustion).
client.events.on(OjinEvent.ConnectionClosed, ({ disconnectReason }) => {
  console.log("Session closed:", disconnectReason);
});

await client.connect();

// Convenience senders
await client.sendText("Hello!");

const pcm = new Uint8Array(/* PCM int16 audio bytes */);
await client.sendAudio(pcm);

await client.interrupt();       // cancel in-flight interaction
await client.endInteraction();  // signal end of turn

await client.close();
```

> **Tip:** `client.events.on()` returns an unsubscribe function. Call it in cleanup handlers (e.g. React's `useEffect` teardown on your backend companion component).

## API Reference

### `OjinClient` constructor

```ts
new OjinClient(options: OjinClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wsUrl` | `string` | — | WebSocket endpoint URL |
| `apiKey` | `string` | — | Ojin API key — read from `process.env` |
| `configId` | `string` | — | Avatar / model configuration ID |
| `autoWaitForReady` | `boolean` | `false` | Buffer `sendMessage` calls until `session.ready` |
| `autoReconnect` | `boolean` | `true` | Reconnect automatically on live-drop |
| `maxReconnectAttempts` | `number` | `5` | Maximum reconnect attempts before giving up |
| `outgoingQueue.maxMessages` | `number` | `100` | Outgoing queue depth |
| `outgoingQueue.onOverflow` | `"reject" \| "dropOldest" \| "dropNewest"` | `"reject"` | Overflow policy; `"reject"` throws `QueueFullError` |
| `maxRequestsPerSecond` | `number` | `6` | Client-side rate limiter (server cap is 6 req/sec per connection) |
| `logger` | `OjinLogger` | — | Custom logger (must implement `debug/info/warn/error`) |

### Methods

| Method | Description |
|--------|-------------|
| `connect(): Promise<void>` | Open the WebSocket connection |
| `close(): Promise<void>` | Close the connection |
| `sendText(text, params?)` | Send a text interaction |
| `sendAudio(pcm, params?)` | Send PCM int16 audio (auto-chunked at 500 KB) |
| `interrupt()` | Cancel the in-flight interaction |
| `endInteraction()` | Signal end of turn |
| `sendMessage(msg)` | Low-level raw send (advanced) |
| `isConnected(): boolean` | Current connection check |

## Events

Listen with `client.events.on(eventName, handler)`. The handler receives the typed payload shown below. `on()` returns an unsubscribe function.

| Event | Payload | When it fires |
|-------|---------|---------------|
| `session.state_changed` | `ConnectionState` | Any connection state transition |
| `connection.opened` | _(none)_ | WebSocket handshake complete |
| `session.closed` | `{ code: number; reason: string; disconnectReason: DisconnectReason }` | Session ended (client/server/error) |
| `connection.reconnecting` | `{ attempt: number; delayMs: number }` | Automatic reconnect attempt starting |
| `connection.reconnected` | _(none)_ | Reconnect succeeded; session may re-enter setup |
| `session.ready` | `OjinSessionReadyMessage` | Inference server is ready for interactions |
| `session.waiting_for_ready` | `{ configId: string; elapsedMs: number }` | First `sendMessage` call is blocked pending ready |
| `interaction.response` | `OjinInteractionResponseMessage` | Video/audio frame received from server |
| `interaction.error` | `OjinErrorResponseMessage` | Application-level error from server |
| `queue.overflow` | `{ dropped: number }` | Outgoing queue dropped messages (drop-oldest / drop-newest paths) |

## Error Codes

All SDK errors extend `OjinError` and carry a `.code: OjinErrorCode` field plus optional `.details`. Catch by typed class for retryable/structured handling; fall through to `OjinError` for codes without a dedicated class.

| Code | Typed class | Retryable? | Origin | What it means |
|------|-------------|------------|--------|---------------|
| `CONNECTION_FAILED` | `ConnectionError` | No | SDK-local | WS upgrade refused or network error |
| `NOT_CONNECTED` | `OjinError` | No | SDK-local | `sendMessage` called before `connect()` |
| `SERVER_NOT_READY` | `OjinError` | No | SDK-local | `sendMessage` before `session.ready` with `autoWaitForReady: false` |
| `PROTOCOL_ERROR` | `ProtocolError` | No | SDK-local | Unparseable frame or plain-text server error |
| `CONFIGURATION_ERROR` | `ConfigurationError` | No | SDK-local | Invalid constructor option |
| `RECONNECT_FAILED` | `OjinError` | No | SDK-local | All reconnect attempts exhausted |
| `READY_TIMEOUT` | `ReadyTimeoutError` | No | SDK-local | `waitForReady` deadline exceeded |
| `QUEUE_FULL` | `QueueFullError` | No | SDK-local | Outgoing queue full with `onOverflow: "reject"` |
| `TIMEOUT` | `TimeoutError` | Yes | server/SDK | Operation exceeded processing time |
| `AUTH_FAILED` | `AuthError` | No | server | Invalid API key |
| `UNAUTHORIZED` | `AuthError` | No | server | Caller lacks permission for this resource |
| `MISSING_CONFIG_ID` | `OjinError` | No | server | `configId` not provided — programmer error |
| `INVALID_MESSAGE` | `OjinError` | No | server | Malformed request payload — programmer error |
| `INVALID_HEADERS` | `AuthError` | No | server | Missing or invalid `Authorization` header |
| `MODEL_NOT_FOUND` | `OjinError` | No | server | `configId` does not map to a known model |
| `BACKEND_UNAVAILABLE` | `BackendUnavailableError` | Yes (backoff) | server | No healthy inference backend available |
| `RATE_LIMITED` | `RateLimitError` | Yes (throttle) | server | Exceeded 6 req/sec per connection |
| `CANCELLED` | _(not emitted)_ | — | server | Server ack for `interrupt()`; consumed silently — not emitted as `interaction.error` |
| `INTERNAL_ERROR` | `OjinError` | Yes | server | Unexpected server fault |
| `FRAME_SIZE_EXCEEDED` | `OjinError` | No | server | Client message exceeded 512 KB server limit |

## Migration (v0.1 → v1.0)

| What changed | Impact |
|---|---|
| Browser path removed entirely | Node-only package; no browser bundle |
| Polling API deleted | The v0.1 pull-model API no longer exists; use `client.events.on(OjinEvent.InteractionResponse, …)` instead |
| `ConnectionClosed` event delivers `{ code, reason, disconnectReason }` object | Shape change from the v0.1 `(code, reason)` positional args |
| Event string values use dotted namespace (`session.ready`, `connection.opened`, etc.) | Update any literal string comparisons |
| `reconnectAttempts` → `initialConnectAttempts` / `maxReconnectAttempts` | Option rename + split |
| `reconnectDelay` (seconds) → `reconnectBackoff.initialMs` (milliseconds) | Rename and unit change; constructor throws `ConfigurationError` on old name |
| `OjinErrorCode.UnknownMessage` removed | Catch-blocks on the removed member become dead code |
| `autoWaitForReady` default flipped to `false` | Consumers that relied on implicit buffering must set `autoWaitForReady: true` explicitly |

## Development

```bash
pnpm install
pnpm run build       # CJS + ESM output
pnpm test            # Run tests
pnpm run lint:fix    # Lint and fix
pnpm run typecheck   # Type-check only
```

## License

Apache-2.0
