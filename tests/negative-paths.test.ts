/**
 * Defensive negative-path regression tests for ost-nptt.
 *
 * Covers the currently implemented behavior for:
 *  - malformed text and binary inbound frames
 *  - duplicate session.ready frames
 *  - server errorResponse before session.ready
 *  - concurrent connect() calls
 *  - sendMessage() after close()
 *  - mid-chunk audio close / current non-atomic audio-drop behavior
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import type { OjinError } from "../src/index.js";
import {
  ConnectionError,
  ConnectionState,
  OjinAudioInputMessage,
  OjinClient,
  OjinErrorCode,
  OjinEvent,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
  ProtocolError,
} from "../src/index.js";
import { deserializeInteractionInputMessage } from "../src/protocol/interaction-messages.js";
import { MessageType } from "../src/protocol/session-messages.js";

const AUDIO_CHUNK_SIZE = 500_000;

interface OjinClientTestInternals {
  _connectionState: ConnectionState;
  _inferenceServerReady: boolean;
  _lastSessionReady: OjinSessionReadyMessage | null;
  transport: {
    isOpen: boolean;
    send(data: string | Uint8Array): void;
    close(): void;
  } | null;
  openTransport(): Promise<void>;
  setConnectionState(state: ConnectionState): void;
  handleClose(code: number, reason: string): Promise<void>;
}

function sessionReadyFrame(parameters: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: MessageType.SessionReady,
    payload: {
      traceId: "test-trace",
      status: "success",
      load: 0.5,
      timestamp: Date.now(),
      parameters,
    },
  });
}

function errorFrame(code: OjinErrorCode, message: string): string {
  return JSON.stringify({
    type: MessageType.ErrorResponse,
    payload: {
      code,
      message,
      details: null,
      timestamp: Date.now(),
    },
  });
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("OjinClient defensive negative paths", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverWs: WS | null = null;

  beforeEach(async () => {
    serverWs = null;
    vi.restoreAllMocks();
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        port = (wss.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function makeClient(
    overrides?: Partial<ConstructorParameters<typeof OjinClient>[0]>,
  ): OjinClient {
    return new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      configId: "test-config-id",
      ...overrides,
    });
  }

  it("malformed text frame emits ProtocolError with the raw payload and keeps the socket connected", async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.send("not valid json");
    });

    const client = makeClient();
    const errors: OjinError[] = [];
    client.events.on(OjinEvent.Error, (error) => {
      errors.push(error);
    });

    await client.connect();
    await waitUntil(() => errors.length === 1);

    expect(errors[0]).toBeInstanceOf(ProtocolError);
    expect(errors[0].code).toBe(OjinErrorCode.ProtocolError);
    expect((errors[0].details as { rawMessage: string }).rawMessage).toBe("not valid json");
    expect(client.connectionState).toBe(ConnectionState.Connected);
    expect(client.isServerReady).toBe(false);

    await client.close();
  });

  it("truncated binary frame is dropped without a public error or interaction event", async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    let errorCount = 0;
    let responseCount = 0;

    client.events.on(OjinEvent.Error, () => {
      errorCount++;
    });
    client.events.on(OjinEvent.InteractionResponse, () => {
      responseCount++;
    });

    await client.connect();
    await waitUntil(() => client.isServerReady && serverWs !== null);

    // Current runtime behavior: malformed binary frames are logged internally
    // and dropped; no public error event is emitted.
    serverWs?.send(Buffer.from([1, 2, 3]), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errorCount).toBe(0);
    expect(responseCount).toBe(0);
    expect(client.connectionState).toBe(ConnectionState.Connected);

    await client.close();
  });

  it("duplicate session.ready frames are re-emitted and replace the cached ready payload", async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient();
    const sessionReadyMessages: OjinSessionReadyMessage[] = [];

    client.events.on(OjinEvent.SessionReady, (message) => {
      sessionReadyMessages.push(message);
    });

    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs?.send(sessionReadyFrame({ seq: 1 }));
    await waitUntil(() => sessionReadyMessages.length === 1);

    serverWs?.send(sessionReadyFrame({ seq: 2 }));
    await waitUntil(() => sessionReadyMessages.length === 2);

    const cached = await client.waitForReady();

    expect(sessionReadyMessages).toHaveLength(2);
    expect(sessionReadyMessages[0]).toBeInstanceOf(OjinSessionReadyMessage);
    expect(sessionReadyMessages[1]).toBeInstanceOf(OjinSessionReadyMessage);
    expect(sessionReadyMessages[0].parameters).toEqual({ seq: 1 });
    expect(sessionReadyMessages[1].parameters).toEqual({ seq: 2 });
    expect(cached.parameters).toEqual({ seq: 2 });

    await client.close();
  });

  it("errorResponse before session.ready emits Error and leaves the client connected but not ready", async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient();
    const errors: OjinError[] = [];
    client.events.on(OjinEvent.Error, (error) => {
      errors.push(error);
    });

    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs?.send(errorFrame(OjinErrorCode.InternalError, "boot failed"));
    await waitUntil(() => errors.length === 1);

    const sendError = await client
      .sendMessage(new OjinTextInputMessage("before-ready"))
      .catch((error: unknown) => error);

    expect(errors[0].code).toBe(OjinErrorCode.InternalError);
    expect(client.connectionState).toBe(ConnectionState.Connected);
    expect(client.isServerReady).toBe(false);
    expect(sendError).toBeInstanceOf(ConnectionError);
    expect((sendError as ConnectionError).code).toBe(OjinErrorCode.ServerNotReady);

    await client.close();
  });

  it("concurrent connect() calls do not start a second transport open", async () => {
    const client = makeClient();
    const internals = client as unknown as OjinClientTestInternals;
    let releaseOpenTransport!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpenTransport = resolve;
    });

    const openTransportSpy = vi.spyOn(internals, "openTransport").mockImplementation(async () => {
      await openGate;
      internals.setConnectionState(ConnectionState.Connected);
    });

    const firstConnect = client.connect();
    let firstSettled = false;
    void firstConnect.finally(() => {
      firstSettled = true;
    });

    await Promise.resolve();

    const winner = await Promise.race([
      firstConnect.then(() => "first"),
      client.connect().then(() => "second"),
    ]);

    expect(winner).toBe("second");
    expect(firstSettled).toBe(false);
    expect(openTransportSpy).toHaveBeenCalledTimes(1);
    expect(client.connectionState).toBe(ConnectionState.Connecting);

    releaseOpenTransport();
    await firstConnect;

    expect(client.connectionState).toBe(ConnectionState.Connected);

    await client.close();
  });

  it("sendMessage() after close() rejects with the current ConnectionFailed code", async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    await client.connect();
    await waitUntil(() => client.isServerReady && serverWs !== null);
    await client.close();

    const error = await client
      .sendMessage(new OjinTextInputMessage("after-close"))
      .catch((err) => err);

    // Current behavior: this guard throws ConnectionError without an explicit
    // NOT_CONNECTED code, so the inherited default code is CONNECTION_FAILED.
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).code).toBe(OjinErrorCode.ConnectionFailed);
    expect(client.connectionState).toBe(ConnectionState.Disconnected);
  });

  it("mid-chunk audio close drops remaining chunks after the first send and sendMessage() still resolves", async () => {
    const client = makeClient({ autoReconnect: false });
    const internals = client as unknown as OjinClientTestInternals;
    const sentFrames: Uint8Array[] = [];
    const closeEvents: Array<{ code: number; reason: string }> = [];

    client.events.on(OjinEvent.ConnectionClosed, ({ code, reason }) => {
      closeEvents.push({ code, reason });
    });

    internals._connectionState = ConnectionState.Connected;
    internals._inferenceServerReady = true;
    internals._lastSessionReady = new OjinSessionReadyMessage({});
    internals.transport = {
      isOpen: true,
      send(data) {
        sentFrames.push(data as Uint8Array);
        if (sentFrames.length === 1) {
          this.isOpen = false;
          void internals.handleClose(1006, "mid-chunk-close");
        }
      },
      close() {
        this.isOpen = false;
      },
    };

    const audio = new Uint8Array(AUDIO_CHUNK_SIZE * 2 + 17);
    audio.fill(7);

    await expect(client.sendMessage(new OjinAudioInputMessage(audio))).resolves.toBeUndefined();
    await waitUntil(() => client.connectionState === ConnectionState.Disconnected);

    // Current implementation is not atomic for multi-chunk audio sends: once
    // the transport closes after the first chunk, subsequent chunk sends become
    // no-ops because handleClose() nulls the transport synchronously.
    expect(sentFrames).toHaveLength(1);
    expect(deserializeInteractionInputMessage(sentFrames[0]).payload.payload).toHaveLength(
      AUDIO_CHUNK_SIZE,
    );
    expect(closeEvents).toEqual([{ code: 1006, reason: "mid-chunk-close" }]);
  });
});
