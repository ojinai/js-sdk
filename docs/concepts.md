# Ojin SDK — Concepts

This page bridges the README quick-start and the full API reference.
Read it front-to-back to understand the mental model before diving into
individual symbols.

---

## Session

A **session** is the lifetime of one
{@link index.OjinClient | OjinClient} connection — from the
moment `connect()` resolves until `close()` is called or the server drops the
link.

Within a session the Ojin inference server goes through an initialisation phase
before it accepts interactions. The SDK tracks this internally and exposes it
via the {@link index.OjinEvent.SessionReady | OjinEvent.SessionReady} event
and the `waitForReady()` helper. Always await `waitForReady()` before sending
any messages; it resolves immediately if the server is already ready, or waits
up to `timeoutMs` milliseconds (default 10 s) before rejecting with
{@link index.ReadyTimeoutError | ReadyTimeoutError}.

```text
connect()
   │
   ▼
ConnectionState.Connecting
   │
   ▼  (WebSocket handshake succeeds)
ConnectionState.Connected ──── OjinEvent.ConnectionOpened fires
   │
   ▼  (inference server warm-up completes)
OjinEvent.SessionReady fires ── waitForReady() resolves
   │
   │  ... interactions happen here ...
   │
   ▼  (close() called or server drops link)
ConnectionState.Disconnected ── OjinEvent.ConnectionClosed fires
```

**API refs:** {@link index.OjinClient | OjinClient},
{@link index.OjinClientOptions | OjinClientOptions},
{@link index.OjinEvent | OjinEvent},
{@link index.ConnectionState | ConnectionState},
{@link index.ReadyTimeoutError | ReadyTimeoutError}

---

## Interaction

An **interaction** is a single request/response turn within a session. You
start one by sending input (text or audio bytes) followed by
{@link index.OjinEndInteractionMessage | OjinEndInteractionMessage}, which
signals end-of-turn. The server synthesises a response and streams it back as
one or more
{@link index.OjinInteractionResponseMessage | OjinInteractionResponseMessage}
frames; the last frame carries `isFinalResponse: true`.

For text input, the high-level helpers are:
- `client.sendTextTurn(...)` to send the turn and keep consuming frames via events
- `client.sendTextTurnAndWait(...)` to send the turn and resolve on the final speech frame
- `client.streamTextTurn(...)` to send the turn and consume only that turn's speech frames via `for await ... of`

```text
sendMessage(OjinTextInputMessage | OjinAudioInputMessage)
    ↓  (repeat for additional audio chunks)
sendMessage(OjinEndInteractionMessage)
    ↓
OjinEvent.InteractionResponse  (isFinalResponse: false)  × N
OjinEvent.InteractionResponse  (isFinalResponse: true)   × 1
```

You can cancel an in-flight interaction at any time by sending
{@link index.OjinCancelInteractionMessage | OjinCancelInteractionMessage}.
The server replies with a `CANCELLED` error code, which the SDK consumes
silently — no {@link index.OjinEvent | OjinEvent}.Error is emitted for
cancellation acknowledgements.

**API refs:** {@link index.OjinTextInputMessage | OjinTextInputMessage},
{@link index.OjinAudioInputMessage | OjinAudioInputMessage},
{@link index.OjinEndInteractionMessage | OjinEndInteractionMessage},
{@link index.OjinCancelInteractionMessage | OjinCancelInteractionMessage},
{@link index.OjinInteractionResponseMessage | OjinInteractionResponseMessage}

---

## Frame types (JPEG video + PCM audio)

Each {@link index.OjinInteractionResponseMessage | OjinInteractionResponseMessage}
carries two binary payloads:

| Field | Encoding |
|-------|----------|
| `videoFrameBytes` | Single JPEG-encoded video frame |
| `audioFrameBytes` | Raw PCM int16 audio, little-endian, 16 kHz mono |

A **frame** is the atomic delivery unit — one video image paired with the
corresponding audio slice. Your backend receives frames in
`OjinEvent.InteractionResponse` callbacks and is responsible for forwarding
them through its own transport (WebSocket, SSE, HTTP chunked) to your frontend.

The video and audio in one frame are time-aligned: render them together for
a lip-synced result.

**API refs:** {@link index.OjinInteractionResponseMessage | OjinInteractionResponseMessage},
{@link index.FrameType | FrameType}

---

## Idle vs speech

Every frame carries a `frameType` discriminant from the
{@link index.FrameType | FrameType} enum:

| Value | Constant | Meaning |
|-------|----------|---------|
| `0` | `FrameType.Idle` | Idle/looping background frame — persona is not speaking |
| `1` | `FrameType.Speech` | Speech-driven frame — persona is actively speaking |

Idle frames are emitted continuously even when no interaction is in progress,
giving you a natural "talking head" to display while the user waits. When the
server starts generating speech for an interaction, frames transition from
`Idle` to `Speech`. Once the final speech frame is delivered
(`isFinalResponse: true`), frames revert to `Idle`.

A typical rendering loop tests `msg.frameType === FrameType.Idle` to decide
whether to play a looping animation or advance a live speech stream.

**API refs:** {@link index.FrameType | FrameType},
{@link index.OjinInteractionResponseMessage | OjinInteractionResponseMessage}

---

## Client vs server messages

The SDK draws a hard distinction between messages you **send** and messages you
**receive**, enforced at compile time through two separate class hierarchies:

| Direction | Base class | Concrete classes |
|-----------|------------|-----------------|
| You → Ojin | `OjinClientMessage` | `OjinTextInputMessage`, `OjinAudioInputMessage`, `OjinEndInteractionMessage`, `OjinCancelInteractionMessage` |
| Ojin → You | `OjinServerMessage` | `OjinSessionReadyMessage`, `OjinInteractionResponseMessage` |

`OjinClient.sendMessage()` accepts only
{@link index.OjinClientMessage | OjinClientMessage} subclasses.
Passing a server message is a **compile-time type error** — the TypeScript
compiler rejects the call before the code reaches the runtime.

You never construct server messages directly. They are created by the SDK when
it deserialises incoming WebSocket frames, and delivered to your handlers via
`client.events.on(OjinEvent.InteractionResponse, ...)` and
`client.events.on(OjinEvent.SessionReady, ...)`.

**API refs:** {@link index.OjinClientMessage | OjinClientMessage},
{@link index.OjinServerMessage | OjinServerMessage},
{@link index.OjinClient | OjinClient}

---

## Events vs polling — why events only

The SDK surfaces all asynchronous state changes through
{@link index.OjinEventEmitter | OjinEventEmitter} rather than providing a
polling API or an async iterator. Reasons:

- **Minimal surface.** One `on/off` pattern composes with any downstream
  transport (WebSocket, SSE, message queue) without the SDK needing to know
  which one you use.
- **No buffering.** Frames arrive as fast as the inference server produces
  them. An event callback fires immediately; there is no SDK-side queue to
  drain, so you control back-pressure in your own transport layer.
- **Predictable teardown.** `client.events.removeAllListeners()` clears all
  handlers in one call, making cleanup deterministic.

Register handlers with `client.events.on(OjinEvent.<name>, handler)` and
remove them with `client.events.off(OjinEvent.<name>, handler)` (same handler
reference) or `client.events.removeAllListeners(event?)`.

There is no `client.receiveMessage()` or `client.messages()` async iterator —
message delivery is push-only through the event emitter.

**API refs:** {@link index.OjinEvent | OjinEvent},
{@link index.OjinEventEmitter | OjinEventEmitter},
{@link index.OjinEventCallbacks | OjinEventCallbacks}

---

## Why this SDK runs server-side only

The Ojin STV WebSocket requires an **API key** to be sent in the HTTP upgrade
headers. Placing that key in browser-executable code — or encoding it in a URL
visible to the browser — would expose it to anyone who opens DevTools. Node.js
server processes can hold the key in environment variables that never leave the
server.

The intended architecture is:

```text
Browser / mobile app
       │
       │  your own transport  (WebSocket, SSE, HTTP — you design this)
       │
       ▼
  Your Node.js backend
       │  uses @ojinai/js-sdk
       │  OJIN_API_KEY lives only here
       │
       ▼
  Ojin STV service  (wss://…)
```

The SDK also uses Node.js-native APIs (`ws`, Node `Readable` streams,
`Buffer`) that do not exist in browser runtimes. It is not distributed as a
browser bundle and will not work in a browser, React Native app, or any other
untrusted runtime.

> **Browser and mobile recipes are not included in this documentation.**
> They will only be written when the Ojin backend ships a media-transport
> ingress (WebRTC / LiveKit / Daily) that allows clients to connect without
> embedding an API key.

**API refs:** {@link index.OjinClientOptions | OjinClientOptions}

---

## Recipes

Copy-paste starting points for common Node-side integration tasks:

- [Ingest audio from a Node.js Readable stream](recipes/audio-from-node-stream.md)
- [Forward frames to a downstream client transport](recipes/forward-frames-to-client.md)
- [Handle an interruption from your own control channel](recipes/handle-interruption.md)
- [Error handling at the right granularity](recipes/error-handling.md)
