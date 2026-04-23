# Recipe: Forward frames to a downstream client transport

The Ojin SDK delivers video (JPEG) and audio (PCM int16) frames to your
Node.js backend. Your backend is responsible for forwarding those frames to
its own frontend over whatever transport it uses — WebSocket, SSE, HTTP
chunked transfer, a message queue, etc.

This recipe shows the **handoff point**: where the SDK hands you a frame and
where you inject it into your own transport. It deliberately does not prescribe
the downstream transport.

## Code

```typescript
import {
  OjinClient,
  OjinEvent,
  FrameType,
  OjinInteractionResponseMessage,
  OjinTextInputMessage,
  OjinEndInteractionMessage,
} from "ojin-client";

declare const myTransport: {
  send(payload: {
    interactionId: string;
    video: Uint8Array;
    audio: Uint8Array;
    isFinal: boolean;
    isIdle: boolean;
  }): void;
};

const client = new OjinClient({
  wsUrl: process.env.OJIN_WS_URL!,
  apiKey: process.env.OJIN_API_KEY!,
  configId: process.env.OJIN_CONFIG_ID!,
});

// Register before connect() so no frames are missed.
client.events.on(OjinEvent.InteractionResponse, (msg: OjinInteractionResponseMessage) => {
  myTransport.send({
    interactionId: msg.interactionId,
    video: msg.videoFrameBytes,
    audio: msg.audioFrameBytes,
    isFinal: msg.isFinalResponse,
    isIdle: msg.frameType === FrameType.Idle,
  });
});
await client.connect();
await client.waitForReady();
await client.sendMessage(new OjinTextInputMessage("Hello!"));
await client.sendMessage(new OjinEndInteractionMessage());
```

## Frame lifecycle

```text
OjinEvent.InteractionResponse (isIdle: true)   ← continuous before interaction
OjinEvent.InteractionResponse (isIdle: false)  ← speech frames during response
OjinEvent.InteractionResponse (isIdle: false, isFinal: true)  ← last speech frame
OjinEvent.InteractionResponse (isIdle: true)   ← back to idle loop
```

`isFinalResponse: true` marks the end of the current interaction's speech
output. Use it to signal your frontend that the avatar has finished speaking.

## Downstream transport notes

- **WebSocket.** Serialize `video` and `audio` as binary frames (two separate
  `ws.send(buffer, { binary: true })` calls, or multiplex them into a single
  framing envelope).
- **SSE.** Base64-encode each binary buffer and send as a JSON event:
  `data: {"video":"<base64>","audio":"<base64>"}\n\n`.
- **Back-pressure.** The SDK does not buffer frames — if your transport is
  slow, handle back-pressure in your own send layer (e.g. drop idle frames,
  queue speech frames with a bounded buffer).

## What about browser capture and frame rendering?

Browser-side media capture and frame rendering are **not covered here**.
The Ojin SDK v1.0 is Node-only. Those recipes will be added when the Ojin
backend ships a media-transport ingress (WebRTC / LiveKit / Daily) that
allows browser clients to connect safely. See the
[concepts page](../concepts.md#why-this-sdk-runs-server-side-only) for
background.
