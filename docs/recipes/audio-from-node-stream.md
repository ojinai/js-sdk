# Recipe: Ingest audio from a Node.js Readable stream

Ojin accepts PCM int16 audio via
{@link index.OjinAudioInputMessage | OjinAudioInputMessage}.
This recipe shows how to read audio from a Node.js `Readable` — whether that
is a local file, an `ffmpeg` pipe, or a decoded upstream client transport.

## Audio format requirements

| Parameter | Value |
|-----------|-------|
| Encoding | Signed 16-bit integer (int16), little-endian |
| Sample rate | 16 000 Hz (16 kHz) |
| Channels | 1 (mono) |

Convert to this format with `ffmpeg` before sending:

```bash
ffmpeg -i input.wav -ar 16000 -ac 1 -f s16le recording.pcm
```

## Code

```typescript
import { createReadStream } from "node:fs";
import {
  OjinClient,
  OjinEvent,
  OjinAudioInputMessage,
  OjinEndInteractionMessage,
  OjinSessionReadyMessage,
} from "@ojinai/js-sdk";

const client = new OjinClient({
  wsUrl: process.env.OJIN_WS_URL!,
  apiKey: process.env.OJIN_API_KEY!,
  configId: process.env.OJIN_CONFIG_ID!,
});

client.events.on(OjinEvent.InteractionResponse, (msg) => {
  // Forward video (JPEG) and audio (PCM int16) frames to your frontend.
  console.log("frame", msg.frameType, "final:", msg.isFinalResponse);
});

await client.connect();
const ready: OjinSessionReadyMessage = await client.waitForReady();
console.log("Server ready, parameters:", ready.parameters);

// Read PCM int16 audio from a file (16 kHz, mono, signed 16-bit LE).
// Replace createReadStream with any Node.js Readable — ffmpeg pipe, upstream
// WebSocket chunks decoded to PCM, etc.
const stream = createReadStream("recording.pcm");
const chunks: Buffer[] = [];
for await (const chunk of stream) {
  chunks.push(chunk as Buffer);
}
const pcm = new Uint8Array(Buffer.concat(chunks));

// sendMessage auto-chunks large buffers at 500 KB to fit the server limit.
await client.sendMessage(new OjinAudioInputMessage(pcm));
await client.sendMessage(new OjinEndInteractionMessage());

await client.close();
```

## Streaming in real time

If you are receiving audio in real time (e.g. from an upstream microphone
stream forwarded by your frontend), send each chunk as soon as it arrives
rather than buffering the whole recording:

```ts
// Illustrative — liveStream is your app-defined Readable source
for await (const chunk of liveStream) {
  const pcm = new Uint8Array((chunk as Buffer).buffer as ArrayBuffer);
  await client.sendMessage(new OjinAudioInputMessage(pcm));
}
await client.sendMessage(new OjinEndInteractionMessage());
```

The SDK will chunk each `OjinAudioInputMessage` at 500 KB automatically, so
you do not need to split the buffer yourself.

## Notes

- **Sample rate matters.** Sending audio at the wrong rate causes the model to
  hear fast or slow speech. Always resample to 16 kHz before sending.
- **Silence is valid.** You may send an `OjinAudioInputMessage` containing
  silence bytes; the model will process it as a quiet turn.
- **Upstream forwarding.** If your frontend sends PCM audio to your Node.js
  backend over your own WebSocket, decode the incoming `ArrayBuffer` with
  `new Uint8Array(arrayBuffer)` and forward it directly — no re-encoding
  needed.
