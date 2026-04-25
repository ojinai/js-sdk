import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import { OjinErrorCode } from "../../src/errors.js";
import { ConnectionState, DisconnectReason, OjinClient, OjinEvent } from "../../src/index.js";
import { MessageType } from "../../src/protocol/session-messages.js";

function sessionReadyFrame(): string {
  return JSON.stringify({
    type: MessageType.SessionReady,
    payload: {
      traceId: "test-trace",
      status: "success",
      load: 0.5,
      timestamp: Date.now(),
      parameters: {},
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
    },
  });
}

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("OjinClient session.closed disconnect reasons", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        port = (wss.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const ws of wss.clients) ws.terminate();
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

  it("emits session.closed with client_initiated on client.close()", async () => {
    wss.on("connection", (ws) => {
      ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    let closed: { code: number; reason: string; disconnectReason: DisconnectReason } | null = null;

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed = payload;
    });

    await client.connect();
    await waitUntil(() => client.isServerReady);
    await client.close();

    expect(OjinEvent.ConnectionClosed).toBe("session.closed");
    expect(closed).toEqual({
      code: 1000,
      reason: "",
      disconnectReason: DisconnectReason.ClientInitiated,
    });
  });

  it("maps auth no-retry close to authentication_failed", async () => {
    let socket: WS | null = null;

    wss.on("connection", (ws) => {
      socket = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    const closed: Array<{ code: number; reason: string; disconnectReason: DisconnectReason }> = [];

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed.push(payload);
    });

    await client.connect();
    await waitUntil(() => client.isServerReady);

    socket?.send(errorFrame(OjinErrorCode.AuthFailed, "auth failed"));
    socket?.close(4001, "auth failed");

    await waitUntil(() => client.connectionState === ConnectionState.Disconnected);

    expect(closed).toEqual([
      {
        code: 4001,
        reason: "auth failed",
        disconnectReason: DisconnectReason.AuthenticationFailed,
      },
    ]);
  });

  it("maps reconnect exhaustion to reconnect_failed", async () => {
    let connectionCount = 0;
    let initialSocket: WS | null = null;
    const closed: Array<{ code: number; reason: string; disconnectReason: DisconnectReason }> = [];

    wss.on("connection", (ws) => {
      connectionCount++;
      if (connectionCount === 1) {
        initialSocket = ws;
        ws.send(sessionReadyFrame());
        return;
      }
      setTimeout(() => ws.terminate(), 10);
    });

    const client = makeClient({
      reconnectBackoff: { initialMs: 5, maxMs: 5, multiplier: 1, jitter: 0 },
      maxReconnectAttempts: 2,
    });

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed.push(payload);
    });

    await client.connect();
    await waitUntil(() => client.isServerReady);

    initialSocket?.terminate();

    await waitUntil(
      () => client.connectionState === ConnectionState.Disconnected && closed.length === 1,
      5000,
    );

    expect(closed[0]?.disconnectReason).toBe(DisconnectReason.ReconnectFailed);
  });

  it("maps inbound-idle close to connection_lost", async () => {
    wss.on("connection", (ws) => {
      setTimeout(() => ws.terminate(), 200);
    });

    const client = makeClient({
      autoReconnect: false,
      inboundIdleTimeoutMs: 100,
    });
    let closed: { code: number; reason: string; disconnectReason: DisconnectReason } | null = null;

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed = payload;
    });

    await client.connect();
    await waitUntil(() => closed !== null);

    expect(closed?.disconnectReason).toBe(DisconnectReason.ConnectionLost);
  });

  it("maps server-side non-auth errors to server_initiated when autoReconnect is disabled", async () => {
    let socket: WS | null = null;

    wss.on("connection", (ws) => {
      socket = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient({ autoReconnect: false });
    let closed: { code: number; reason: string; disconnectReason: DisconnectReason } | null = null;

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed = payload;
    });

    await client.connect();
    await waitUntil(() => client.isServerReady);

    socket?.send(errorFrame(OjinErrorCode.BackendUnavailable, "backend unavailable"));
    socket?.close(1011, "backend unavailable");

    await waitUntil(() => closed !== null);

    expect(closed).toEqual({
      code: 1011,
      reason: "backend unavailable",
      disconnectReason: DisconnectReason.ServerInitiated,
    });
  });

  it("maps bare non-stale closes to unknown when autoReconnect is disabled", async () => {
    let socket: WS | null = null;

    wss.on("connection", (ws) => {
      socket = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient({
      autoReconnect: false,
      inboundIdleTimeoutMs: 5_000,
    });
    let closed: { code: number; reason: string; disconnectReason: DisconnectReason } | null = null;

    client.events.on(OjinEvent.ConnectionClosed, (payload) => {
      closed = payload;
    });

    await client.connect();
    await waitUntil(() => client.isServerReady);

    socket?.close(1001, "server shutdown");

    await waitUntil(() => closed !== null);

    expect(closed).toEqual({
      code: 1001,
      reason: "server shutdown",
      disconnectReason: DisconnectReason.Unknown,
    });
  });
});
