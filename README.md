# Ojin Client — TypeScript SDK

Node.js client SDK for the Ojin Speech-To-Video service. **Server-side only** — this SDK must run in a Node process (typically your own backend), not in a browser or mobile app.

## Install

```bash
npm install ojin-client
# or
pnpm add ojin-client
```

Requires Node.js 20+.

## Not for client-side use

**Do not load this SDK in a browser or any untrusted runtime.** The Ojin WebSocket takes an API key on the upgrade request; exposing that key in client code (or in a URL visible to the client) would leak the credential. Browser support is intentionally withdrawn until the Ojin backend ships a real media-transport ingress (WebRTC / LiveKit / Daily).

The expected integration pattern is:

```
Your frontend  ⇄  Your backend (uses @ojinai/js-sdk)  ⇄  Ojin
```

Your backend opens the Ojin connection, owns the API key, and exposes your own client-facing transport (WebSocket, SSE, HTTP, whatever fits) to your frontend.

## Quick Start (Node)

```ts
import {
  OjinClient,
  OjinEvent,
  OjinTextInputMessage,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinEndInteractionMessage,
} from "ojin-client";

const client = new OjinClient({
  wsUrl: "wss://api.ojin.ai/ws",
  apiKey: process.env.OJIN_API_KEY!,
  configId: "your-config-id",
});

client.events.on(OjinEvent.SessionReady, (msg) => {
  console.log("Session ready:", msg.parameters);
});

client.events.on(OjinEvent.InteractionResponse, (msg) => {
  // Forward frames to your own client transport.
  console.log("Video frame:", msg.videoFrameBytes.length, "bytes");
  console.log("Audio frame:", msg.audioFrameBytes.length, "bytes");
  console.log("Frame type:", msg.frameType); // 0 = idle, 1 = speech
});

client.events.on(OjinEvent.ConnectionClosed, (code, reason) => {
  console.log("Disconnected:", code, reason);
});

await client.connect();

await client.sendMessage(new OjinTextInputMessage("Hello!"));

const audioData = new Uint8Array([/* PCM int16 audio bytes */]);
await client.sendMessage(new OjinAudioInputMessage(audioData));

await client.sendMessage(new OjinCancelInteractionMessage());
await client.sendMessage(new OjinEndInteractionMessage());

await client.close();
```

## API Reference

### `OjinClient`

| Method | Description |
|--------|-------------|
| `connect()` | Establish WebSocket connection |
| `close()` | Close the connection |
| `sendMessage(msg)` | Send an OjinMessage |
| `isConnected()` | Check connection state |

### Events

| Event | Description |
|-------|-------------|
| `OjinEvent.ConnectionStateChanged` | Connection state changed |
| `OjinEvent.ConnectionOpened` | WebSocket connected |
| `OjinEvent.ConnectionClosed` | WebSocket closed |
| `OjinEvent.SessionReady` | Server ready for interactions |
| `OjinEvent.InteractionResponse` | Video/audio frame received |
| `OjinEvent.Error` | Error from server |

### Messages

| Class | Direction | Description |
|-------|-----------|-------------|
| `OjinTextInputMessage` | Client → Server | Text input |
| `OjinAudioInputMessage` | Client → Server | Audio input (PCM int16) |
| `OjinCancelInteractionMessage` | Client → Server | Cancel current interaction |
| `OjinEndInteractionMessage` | Client → Server | End interaction |
| `OjinSessionReadyMessage` | Server → Client | Session is ready |
| `OjinInteractionResponseMessage` | Server → Client | Video/audio response |
| `OjinErrorResponseMessage` | Server → Client | Error response |

## Development

```bash
pnpm install
pnpm run build       # Build CJS + ESM
pnpm test            # Run tests
pnpm run lint:fix    # Lint and fix
pnpm run format      # Format code
pnpm run typecheck   # Type-check only
```

## License

Apache-2.0
