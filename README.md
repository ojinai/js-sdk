# Ojin Client — TypeScript SDK

WebSocket client SDK for the Ojin Speech-To-Video service.

## Install

```bash
npm install ojin-client
# or
pnpm add ojin-client
```

## Quick Start

```ts
import { OjinClient, OjinEvent, OjinTextInputMessage, OjinCancelInteractionMessage } from "ojin-client";

const client = new OjinClient({
  wsUrl: "wss://api.ojin.ai/ws",
  apiKey: "your-api-key",
  configId: "your-config-id",
});

// Listen for events
client.events.on(OjinEvent.SessionReady, (msg) => {
  console.log("Session ready!", msg.parameters);
});

client.events.on(OjinEvent.InteractionResponse, (msg) => {
  console.log("Video frame:", msg.videoFrameBytes.length, "bytes");
  console.log("Audio frame:", msg.audioFrameBytes.length, "bytes");
  console.log("Frame type:", msg.frameType); // 0 = idle, 1 = speech
});

client.events.on(OjinEvent.ConnectionClosed, (code, reason) => {
  console.log("Disconnected:", code, reason);
});

// Connect and interact
await client.connect();

// Send text input
await client.sendMessage(new OjinTextInputMessage("Hello!"));

// Send audio input
const audioData = new Uint8Array([...]); // PCM int16 audio bytes
await client.sendMessage(new OjinAudioInputMessage(audioData));

// Cancel current interaction
await client.sendMessage(new OjinCancelInteractionMessage());

// End interaction
await client.sendMessage(new OjinEndInteractionMessage());

// Disconnect
await client.close();
```

## Polling-Style API

For compatibility with the Python SDK pattern, you can also use `receiveMessage()`:

```ts
await client.connect();

const sessionReady = await client.receiveMessage(); // OjinSessionReadyMessage
await client.sendMessage(new OjinTextInputMessage("Hi"));

const response = await client.receiveMessage(); // OjinInteractionResponseMessage
```

## Browser Support

The SDK works in both Node.js and browser environments. In Node.js it uses the `ws` package; in browsers it uses the native `WebSocket` API.

**Note:** Browser WebSocket does not support custom headers. Authentication must be passed via URL query parameters (which the SDK handles automatically via `config_id`).

## API Reference

### `OjinClient`

| Method | Description |
|--------|-------------|
| `connect()` | Establish WebSocket connection |
| `close()` | Close the connection |
| `startInteraction()` | Drain pending response messages |
| `sendMessage(msg)` | Send an OjinMessage |
| `receiveMessage()` | Receive next message (polling) |
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
