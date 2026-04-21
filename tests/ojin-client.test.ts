import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  ConnectionState,
  FrameType,
  MessageType,
  OjinAudioInputMessage,
  OjinClient,
  OjinEvent,
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
  serializeInteractionResponseMessage,
} from "../src/index.js";

describe("OjinClient integration", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        const addr = wss.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });

    wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: MessageType.SessionReady,
          payload: {
            traceId: "test",
            status: "success",
            load: 0.5,
            timestamp: Date.now(),
            parameters: { test: "mock" },
          },
        }),
      );

      ws.on("message", (_data, isBinary) => {
        if (isBinary) {
          const response = {
            type: MessageType.InteractionResponse,
            payload: {
              interactionId: "550e8400-e29b-41d4-a716-446655440000",
              payloads: [
                { payloadType: "image", data: new Uint8Array([1, 2, 3]) },
                { payloadType: "audio", data: new Uint8Array([4, 5, 6]) },
              ],
              isFinalResponse: false,
              timestamp: Date.now(),
              index: 0,
              usage: 1,
            },
          };
          ws.send(serializeInteractionResponseMessage(response));
        }
      });
    });
  });

  afterEach(async () => {
    for (const ws of wss.clients) {
      ws.close();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function createClient(): OjinClient {
    return new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      configId: "test-config-id",
      reconnectAttempts: 1,
      reconnectDelay: 0.1,
    });
  }

  /** Wait for SessionReady using the event system. */
  async function waitForSessionReady(client: OjinClient, timeoutMs = 3000): Promise<void> {
    if (client.isServerReady) return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for session ready")),
        timeoutMs,
      );
      client.events.on(OjinEvent.SessionReady, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  it("should connect and receive session ready via event", async () => {
    const client = createClient();
    const sessionReadyPromise = new Promise<OjinSessionReadyMessage>((resolve) => {
      client.events.on(OjinEvent.SessionReady, resolve);
    });

    await client.connect();
    const msg = await sessionReadyPromise;
    expect(msg).toBeInstanceOf(OjinSessionReadyMessage);
    expect(msg.parameters).toEqual({ test: "mock" });

    await client.close();
  });

  it("should report isServerReady after session ready", async () => {
    const client = createClient();
    await client.connect();
    await waitForSessionReady(client);
    expect(client.isServerReady).toBe(true);
    await client.close();
  });

  it("should send text input and receive interaction response", async () => {
    const client = createClient();
    await client.connect();
    await waitForSessionReady(client);

    const responsePromise = new Promise<OjinInteractionResponseMessage>((resolve) => {
      client.events.on(OjinEvent.InteractionResponse, resolve);
    });

    await client.sendMessage(new OjinTextInputMessage("Hello!"));
    const response = await responsePromise;

    expect(response).toBeInstanceOf(OjinInteractionResponseMessage);
    expect(response.frameType).toBe(FrameType.Speech);
    expect(response.videoFrameBytes.length).toBeGreaterThan(0);
    expect(response.audioFrameBytes.length).toBeGreaterThan(0);

    await client.close();
  });

  it("should send audio input and receive interaction response", async () => {
    const client = createClient();
    await client.connect();
    await waitForSessionReady(client);

    const responsePromise = new Promise<OjinInteractionResponseMessage>((resolve) => {
      client.events.on(OjinEvent.InteractionResponse, resolve);
    });

    await client.sendMessage(new OjinAudioInputMessage(new Uint8Array([0, 1, 2, 3])));
    const response = await responsePromise;
    expect(response).toBeInstanceOf(OjinInteractionResponseMessage);

    await client.close();
  });

  it("should emit connection state changed events", async () => {
    const client = createClient();
    const states: ConnectionState[] = [];
    client.events.on(OjinEvent.ConnectionStateChanged, (state) => states.push(state));

    await client.connect();
    await client.close();

    expect(states).toContain(ConnectionState.Connecting);
    expect(states).toContain(ConnectionState.Connected);
    expect(states).toContain(ConnectionState.Disconnecting);
    expect(states).toContain(ConnectionState.Disconnected);
  });

  it("should throw when sending while disconnected", async () => {
    const client = createClient();
    await expect(client.sendMessage(new OjinTextInputMessage("no connection"))).rejects.toThrow();
  });

  it("should fail to connect with invalid URL", async () => {
    const client = new OjinClient({
      wsUrl: "ws://127.0.0.1:1",
      apiKey: "test",
      configId: "test",
      reconnectAttempts: 1,
      reconnectDelay: 0.01,
    });
    await expect(client.connect()).rejects.toThrow();
    expect(client.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("should use receiveMessage() polling API", async () => {
    const client = createClient();
    await client.connect();

    const msg = await client.receiveMessage();
    expect(msg).toBeInstanceOf(OjinSessionReadyMessage);

    await client.sendMessage(new OjinTextInputMessage("Hello polling!"));
    const response = await client.receiveMessage();
    expect(response).toBeInstanceOf(OjinInteractionResponseMessage);

    await client.close();
  });
});
