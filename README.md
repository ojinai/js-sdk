<!-- markdownlint-disable MD013 -->
# @ojinai/js-sdk — Ojin TypeScript SDK

Node.js / server-side SDK for the Ojin Speech-To-Video service. Connects to
Ojin over WebSocket, delivers video and audio frames to your backend process,
and lets you forward those frames through your own transport to your frontend.
**Server-side only — not for use in browsers or mobile apps.**

## ⚠️ Not for client-side use

**Do not load this SDK in a browser, React Native app, or any other
untrusted runtime.**

The Ojin WebSocket connection requires an API key on the upgrade request.
Exposing that key in client-side code — or in a URL visible to the client —
would leak the credential. The SDK ships as a Node.js package only; it relies
on Node.js-native APIs that do not exist in browser runtimes.

The intended integration pattern is:

```text
Your frontend  ⇄  Your backend (uses @ojinai/js-sdk)  ⇄  Ojin
```

Your backend opens the Ojin connection, owns the API key, and exposes your own
transport (WebSocket, SSE, HTTP) to your frontend. Your frontend never touches
Ojin directly.

Browser support is deferred until the Ojin backend ships a media-transport
ingress (WebRTC / LiveKit / Daily).

## Install

```bash
npm install @ojinai/js-sdk
# or
pnpm add @ojinai/js-sdk
```

Requires Node.js ≥ 20.

## Quick Start

```ts
import {
  OjinClient,
  OjinEvent,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
} from "@ojinai/js-sdk";

const client = new OjinClient({
  wsUrl: "wss://api.ojin.ai/ws",
  apiKey: process.env.OJIN_API_KEY!,    // never hardcode the key
  configId: process.env.OJIN_CONFIG_ID!,
});

// Session is ready — inference server is accepting interactions.
client.events.on(OjinEvent.SessionReady, (msg) => {
  console.log("Session ready, params:", msg.parameters);
});

function forwardFrame(msg: { frameType: number; videoFrameBytes: Uint8Array; audioFrameBytes: Uint8Array }) {
  console.log("Frame received:", {
    frameType: msg.frameType,
    videoBytes: msg.videoFrameBytes.byteLength,
    audioBytes: msg.audioFrameBytes.byteLength,
  });
}

// Forward frames to your own downstream transport.
client.events.on(OjinEvent.InteractionResponse, (msg) => {
  forwardFrame(msg);
});

// Session closed (connection lost or server-initiated).
client.events.on(OjinEvent.ConnectionClosed, ({ code, reason, disconnectReason }) => {
  console.log("Session closed:", code, reason, disconnectReason);
});

// SDK or server errors surface here.
client.events.on(OjinEvent.Error, (err) => {
  console.error("Ojin error:", err.code, err.message);
});

await client.connect();

// Wait until the inference server signals ready before sending.
await client.waitForReady();

// Send a text turn and resolve on the terminal speech frame.
const finalResponse = await client.sendTextTurnAndWait("Hello!");
console.log("Text turn complete:", {
  interactionId: finalResponse.interactionId,
  isFinal: finalResponse.isFinalResponse,
});

// Send PCM int16 audio bytes (auto-chunked at 500 KB).
const pcm = new Uint8Array(/* PCM int16 audio bytes */);
await client.sendMessage(new OjinAudioInputMessage(pcm));

// Cancel the in-flight interaction.
await client.sendMessage(new OjinCancelInteractionMessage());

await client.close();
```

## Concepts

Before diving into the API, read the **[Concepts page](docs/concepts.md)** for an
explanation of sessions, interactions, frame types, idle vs speech states, the
client/server message split, and why this SDK is Node-only.

## Recipes

Copy-paste starting points for common Node-side integration tasks:

- [Ingest audio from a Node.js Readable stream](docs/recipes/audio-from-node-stream.md)
- [Forward frames to a downstream client transport](docs/recipes/forward-frames-to-client.md)
- [Handle an interruption from your own control channel](docs/recipes/handle-interruption.md)
- [Error handling at the right granularity](docs/recipes/error-handling.md)

## API Reference

### `OjinClient` constructor

```ts
new OjinClient(options: OjinClientOptions)
```

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `wsUrl` | `string` | — | WebSocket endpoint URL |
| `apiKey` | `string` | — | Ojin API key — read from `process.env` |
| `configId` | `string` | — | Avatar / model configuration ID |
| `reconnectAttempts` | `number` | `3` | Connection attempts before giving up |
| `reconnectDelay` | `number` | `1.0` | Delay between attempts in seconds |
| `mode` | `string \| null` | `null` | Optional mode flag (e.g. `"dev"`) |
| `logger` | `OjinLogger` | — | Custom logger (must implement `debug/info/warn/error`) |

### Methods

| Method | Description |
| ------ | ----------- |
| `connect(): Promise<void>` | Open the WebSocket connection |
| `close(): Promise<void>` | Close the connection |
| `waitForReady(timeoutMs?): Promise<OjinSessionReadyMessage>` | Resolves when the inference server is ready (default timeout: 10 s) |
| `sendText(text, params?): Promise<void>` | Send only the text input frame |
| `sendTextTurn(text, params?): Promise<void>` | Send text and then end the turn |
| `sendTextTurnAndWait(text, params?, options?): Promise<OjinInteractionResponseMessage>` | Send text, end the turn, and resolve on the final speech frame |
| `streamTextTurn(text, params?, options?): AsyncGenerator<OjinInteractionResponseMessage, void, void>` | Send text, end the turn, and stream speech frames for just that turn |
| `sendAudio(pcm, params?): Promise<void>` | Send PCM int16 audio bytes |
| `interrupt(): Promise<void>` | Cancel the in-flight interaction |
| `endInteraction(): Promise<void>` | End the current interaction |
| `sendMessage(msg: OjinClientMessage): Promise<void>` | Send a typed client message (`OjinTextInputMessage`, `OjinAudioInputMessage`, `OjinCancelInteractionMessage`, `OjinEndInteractionMessage`) |
| `isConnected(): boolean` | Current connection check |

**Getters:** `connectionState: ConnectionState`, `isServerReady: boolean`

### Message classes

| Class | Use |
| ----- | --- |
| `OjinTextInputMessage(text, params?)` | Send text input without ending the turn |
| `OjinAudioInputMessage(pcm, params?)` | Send PCM int16 audio bytes (auto-chunked at 500 KB by `sendMessage`) |
| `OjinCancelInteractionMessage()` | Cancel the in-flight interaction |
| `OjinEndInteractionMessage()` | Signal end of turn |

## Events

Listen with `client.events.on(eventName, handler)`. The handler receives the
typed payload shown below.

| Event | Payload | When it fires |
| ----- | ------- | ------------- |
| `connectionStateChanged` | `ConnectionState` | Any connection state transition |
| `connectionOpened` | _(none)_ | WebSocket handshake complete |
| `session.closed` | `{ code: number, reason: string, disconnectReason: DisconnectReason }` | Connection ended permanently |
| `sessionReady` | `OjinSessionReadyMessage` | Inference server is ready for interactions |
| `interactionResponse` | `OjinInteractionResponseMessage` | Video/audio frame received from server |
| `error` | `OjinError` | SDK or server error (use `.code` for typed dispatch) |
| `session.waiting_for_ready` | `{ configId: string, elapsedMs: number }` | First caller enters `waitForReady()` while server is not yet ready |

Use `OjinEvent.*` constants rather than bare strings:

```ts
import { OjinEvent } from "@ojinai/js-sdk";

client.events.on(OjinEvent.ConnectionStateChanged, (state) => { ... });
client.events.on(OjinEvent.ConnectionOpened, () => { ... });
client.events.on(OjinEvent.ConnectionClosed, ({ code, reason, disconnectReason }) => { ... });
client.events.on(OjinEvent.SessionReady, (msg) => { ... });
client.events.on(OjinEvent.InteractionResponse, (msg) => { ... });
client.events.on(OjinEvent.Error, (err) => { ... });
client.events.on(OjinEvent.WaitingForReady, ({ configId, elapsedMs }) => { ... });
```

To remove a listener, call `client.events.off(event, handler)` with the same
handler reference. To remove all listeners for an event, call
`client.events.removeAllListeners(event)`.

## Error Codes

All SDK errors extend `OjinError` and carry a `.code: OjinErrorCode` field
plus optional `.details`. Catch by typed class for retryable/structured
handling; fall through to `OjinError` for codes without a dedicated class.

| Code | Typed class | Retryable? | Origin | What it means |
| ---- | ----------- | ---------- | ------ | ------------- |
| `CONNECTION_FAILED` | `ConnectionError` | No | SDK-local | WS upgrade refused or network error |
| `NOT_CONNECTED` | `OjinError` | No | SDK-local | `sendMessage` called before `connect()` |
| `SERVER_NOT_READY` | `OjinError` | No | SDK-local | `sendMessage` before server signals ready |
| `PROTOCOL_ERROR` | `ProtocolError` | No | SDK-local | Unparseable frame or plain-text server error |
| `CONFIGURATION_ERROR` | `ConfigurationError` | No | SDK-local | Invalid constructor option |
| `RECONNECT_FAILED` | `OjinError` | No | SDK-local | All reconnect attempts exhausted |
| `READY_TIMEOUT` | `ReadyTimeoutError` | No | SDK-local | `waitForReady` deadline exceeded |
| `QUEUE_FULL` | `QueueFullError` | No | SDK-local | Outgoing queue full |
| `AUDIO_LOCKED` | `AudioLockedError` | No | SDK-local | Audio channel already locked by another caller |
| `TIMEOUT` | `TimeoutError` | Yes | server/SDK | Operation exceeded processing time |
| `AUTH_FAILED` | `AuthError` | No | server | Invalid API key |
| `UNAUTHORIZED` | `AuthError` | No | server | Caller lacks permission for this resource |
| `MISSING_CONFIG_ID` | `OjinError` | No | server | `configId` not provided — programmer error |
| `INVALID_MESSAGE` | `OjinError` | No | server | Malformed request payload — programmer error |
| `INVALID_HEADERS` | `AuthError` | No | server | Missing or invalid `Authorization` header |
| `MODEL_NOT_FOUND` | `OjinError` | No | server | `configId` does not map to a known model |
| `BACKEND_UNAVAILABLE` | `BackendUnavailableError` | Yes (backoff) | server | No healthy inference backend available |
| `RATE_LIMITED` | `RateLimitError` | Yes (throttle) | server | Exceeded server rate limit |
| `CANCELLED` | _(not emitted)_ | — | server | Server ack for `OjinCancelInteractionMessage`; consumed silently |
| `INTERNAL_ERROR` | `OjinError` | Yes | server | Unexpected server fault |
| `FRAME_SIZE_EXCEEDED` | `OjinError` | No | server | Client message exceeded 512 KB server limit |

## Development

```bash
pnpm install
pnpm run build         # CJS + ESM output
pnpm test              # Run tests
pnpm run lint          # Lint + format (auto-fix)
pnpm run lint:check    # Lint + format (read-only; what CI runs)
pnpm run typecheck     # Type-check only
pnpm run integration:check  # Final local release gate
pnpm run precommit     # Fast local gate (lint:check + typecheck + test)
pnpm run prepush       # Full local gate (lint:check + typecheck + test + security)
```

## License

Apache-2.0
