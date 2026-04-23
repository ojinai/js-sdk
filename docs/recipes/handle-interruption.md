# Recipe: Handle an interruption from your own control channel

When your frontend user wants the avatar to stop speaking mid-response, your
frontend sends a "stop" signal to your Node.js backend over your own
control channel. Your backend translates that signal into an
{@link index.OjinCancelInteractionMessage | OjinCancelInteractionMessage},
which cancels the in-flight interaction on the Ojin server.

The SDK does **not** define your control channel — you own the
frontend-to-backend transport. This recipe shows the handoff point: where
your control-channel message maps to an Ojin cancellation.

## Code

```typescript
import {
  OjinClient,
  OjinTextInputMessage,
  OjinEndInteractionMessage,
} from "ojin-client";

// Replace with your own frontend-to-backend control channel.
// "stop" is a custom message type your app defines.
declare const controlChannel: {
  on(event: "stop", handler: () => void): void;
};

const client = new OjinClient({
  wsUrl: process.env.OJIN_WS_URL!,
  apiKey: process.env.OJIN_API_KEY!,
  configId: process.env.OJIN_CONFIG_ID!,
});

await client.connect();
await client.waitForReady();

// Wire the frontend "stop" signal to client.interrupt().
// Guard with isConnected() + isServerReady to avoid sending on a closed session.
controlChannel.on("stop", () => {
  if (client.isConnected() && client.isServerReady) {
    client.interrupt().catch((err) => {
      console.error("Failed to interrupt:", err);
    });
  }
});

// Start an interaction so there is something to cancel.
await client.sendMessage(new OjinTextInputMessage("Tell me a long story"));
await client.sendMessage(new OjinEndInteractionMessage());
```

## What happens after cancellation?

The server responds to `OjinCancelInteractionMessage` with an error message
whose code is `CANCELLED`. The SDK recognises this code and **consumes the
message silently** — it does not emit an `OjinEvent.Error` event. From your
backend's perspective, the interaction simply stops producing frames.

```text
sendMessage(OjinCancelInteractionMessage)
    ↓
server → CANCELLED error (consumed silently by the SDK)
    ↓
InteractionResponse frames stop arriving
    ↓
Idle frames resume (FrameType.Idle)
```

You do not need to set up any `OjinEvent.Error` handler specifically for
`CANCELLED`. If you already have a general error handler, it will not fire for
this code.

## Why `isConnected() && isServerReady`?

Both guards protect against race conditions:

- `isConnected()` — the transport may have been closed (e.g. the user
  navigated away) before the "stop" signal arrived.
- `isServerReady` — the server may not have completed its warm-up yet, in
  which case there is no in-flight interaction to cancel.

If either guard fails, skip the cancel silently — the interaction is already
not running.

## Notes

- `client.interrupt()` is a convenience wrapper around
  `sendMessage(new OjinCancelInteractionMessage())`. Both forms are equivalent;
  prefer `client.interrupt()` for clarity.
- You may call `client.interrupt()` at any time, including before
  `endInteraction()`. The server will stop processing and return to idle.
- After an interruption, the session remains open. You can start a new
  interaction immediately without reconnecting.
