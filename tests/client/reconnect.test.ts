import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import { OjinErrorCode } from "../../src/errors.js";
import { ConnectionState, OjinClient, OjinEvent, OjinTextInputMessage } from "../../src/index.js";
import { deserializeInteractionInputMessage } from "../../src/protocol/interaction-messages.js";
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

function sessionPingFrame(): string {
  return JSON.stringify({
    type: MessageType.SessionPing,
    payload: {
      timestamp: Date.now(),
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

describe("OjinClient reconnect state machine", () => {
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

  it("reconnects on a bare close, emits reconnecting/reconnected, and returns to Connected after fresh session.ready", async () => {
    let connectionCount = 0;
    let firstSocket: WS | null = null;
    let secondSocket: WS | null = null;

    wss.on("connection", (ws) => {
      connectionCount++;
      if (connectionCount === 1) {
        firstSocket = ws;
      } else if (connectionCount === 2) {
        secondSocket = ws;
        ws.send(sessionReadyFrame());
      }
      if (connectionCount === 1) {
        ws.send(sessionReadyFrame());
      }
    });

    const client = makeClient({
      reconnectBackoff: { initialMs: 20, maxMs: 20, multiplier: 1, jitter: 0 },
      maxReconnectAttempts: 2,
    });

    const states: ConnectionState[] = [];
    const reconnecting: Array<{ attempt: number; delayMs: number }> = [];
    let reconnectedCount = 0;
    let readyCount = 0;

    client.events.on(OjinEvent.ConnectionStateChanged, (state) => states.push(state));
    client.events.on(OjinEvent.Reconnecting, (payload) => reconnecting.push(payload));
    client.events.on(OjinEvent.Reconnected, () => {
      reconnectedCount++;
    });
    client.events.on(OjinEvent.SessionReady, () => {
      readyCount++;
    });

    await client.connect();
    await waitUntil(() => readyCount === 1);

    firstSocket?.terminate();

    await waitUntil(() => connectionCount === 2 && readyCount === 2 && reconnectedCount === 1);

    expect(secondSocket?.readyState).toBe(secondSocket?.OPEN);
    expect(client.connectionState).toBe(ConnectionState.Connected);
    expect(states).toContain(ConnectionState.Reconnecting);
    expect(reconnecting).toEqual([{ attempt: 1, delayMs: 20 }]);

    await client.close();
  });

  it("does not reconnect after AUTH_FAILED followed by close", async () => {
    let serverSocket: WS | null = null;
    let connectionCount = 0;
    let reconnectingCount = 0;
    let readyCount = 0;
    const errorCodes: OjinErrorCode[] = [];

    wss.on("connection", (ws) => {
      connectionCount++;
      serverSocket = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient({
      reconnectBackoff: { initialMs: 10, maxMs: 10, multiplier: 1, jitter: 0 },
      maxReconnectAttempts: 3,
    });

    client.events.on(OjinEvent.Reconnecting, () => {
      reconnectingCount++;
    });
    client.events.on(OjinEvent.SessionReady, () => {
      readyCount++;
    });
    client.events.on(OjinEvent.Error, (error) => {
      errorCodes.push(error.code);
    });

    await client.connect();
    await waitUntil(() => readyCount === 1);

    serverSocket?.send(errorFrame(OjinErrorCode.AuthFailed, "auth failed"));
    serverSocket?.close(4001, "auth failed");

    await waitUntil(() => client.connectionState === ConnectionState.Disconnected);

    expect(connectionCount).toBe(1);
    expect(reconnectingCount).toBe(0);
    expect(errorCodes).toContain(OjinErrorCode.AuthFailed);
  });

  it("resets reconnect attempts after each successful fresh session.ready", async () => {
    let connectionCount = 0;
    let readyCount = 0;
    const sockets: WS[] = [];
    const reconnectingAttempts: number[] = [];

    wss.on("connection", (ws) => {
      connectionCount++;
      sockets.push(ws);
      ws.send(sessionReadyFrame());
    });

    const client = makeClient({
      reconnectBackoff: { initialMs: 5, maxMs: 5, multiplier: 1, jitter: 0 },
      maxReconnectAttempts: 2,
    });

    client.events.on(OjinEvent.Reconnecting, ({ attempt }) => {
      reconnectingAttempts.push(attempt);
    });
    client.events.on(OjinEvent.SessionReady, () => {
      readyCount++;
      if (readyCount <= 3) {
        const socketToDrop = sockets[readyCount - 1];
        setTimeout(() => socketToDrop?.terminate(), 10);
      }
    });

    await client.connect();
    await waitUntil(() => connectionCount === 4 && readyCount === 4);
    await waitUntil(() => client.connectionState === ConnectionState.Connected);

    expect(client.connectionState).toBe(ConnectionState.Connected);
    expect(reconnectingAttempts).toEqual([1, 1, 1]);

    await client.close();
  });

  it("stops after maxReconnectAttempts consecutive reconnect failures", async () => {
    let connectionCount = 0;
    let readyCount = 0;
    const reconnectingAttempts: number[] = [];
    const errorCodes: OjinErrorCode[] = [];
    let initialSocket: WS | null = null;

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

    client.events.on(OjinEvent.Reconnecting, ({ attempt }) => {
      reconnectingAttempts.push(attempt);
    });
    client.events.on(OjinEvent.SessionReady, () => {
      readyCount++;
    });
    client.events.on(OjinEvent.Error, (error) => {
      errorCodes.push(error.code);
    });

    await client.connect();
    await waitUntil(() => readyCount === 1);

    initialSocket?.terminate();

    await waitUntil(
      () =>
        client.connectionState === ConnectionState.Disconnected &&
        errorCodes.includes(OjinErrorCode.ReconnectFailed),
      5000,
    );

    expect(connectionCount).toBe(3);
    expect(reconnectingAttempts).toEqual([1, 2]);
  });

  it("preserves pre-ready queued messages across auto reconnect and flushes them on the fresh session.ready", async () => {
    let connectionCount = 0;
    let latestSocket: WS | null = null;
    const received: string[] = [];

    wss.on("connection", (ws) => {
      connectionCount++;
      latestSocket = ws;
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        const message = deserializeInteractionInputMessage(new Uint8Array(data));
        received.push(new TextDecoder().decode(message.payload.payload));
      });
      if (connectionCount === 2) {
        ws.send(sessionReadyFrame());
      }
    });

    const client = makeClient({
      autoWaitForReady: true,
      maxRequestsPerSecond: Infinity,
      reconnectBackoff: { initialMs: 10, maxMs: 10, multiplier: 1, jitter: 0 },
    });

    await client.connect();
    await waitUntil(() => connectionCount === 1);

    const first = client.sendMessage(new OjinTextInputMessage("buffered-1"));
    const second = client.sendMessage(new OjinTextInputMessage("buffered-2"));

    latestSocket?.terminate();

    await waitUntil(() => connectionCount === 2);
    await Promise.all([first, second]);
    await waitUntil(() => received.length === 2);

    expect(received).toEqual(["buffered-1", "buffered-2"]);

    await client.close();
  });

  it("client.close() transitions through Disconnecting to Disconnected in order", async () => {
    let readyCount = 0;

    wss.on("connection", (ws) => {
      ws.send(sessionReadyFrame());
      ws.send(sessionPingFrame());
    });

    const client = makeClient();
    const states: ConnectionState[] = [];
    client.events.on(OjinEvent.ConnectionStateChanged, (state) => states.push(state));
    client.events.on(OjinEvent.SessionReady, () => {
      readyCount++;
    });

    await client.connect();
    await waitUntil(() => readyCount === 1);
    await client.close();

    expect(states.slice(-2)).toEqual([ConnectionState.Disconnecting, ConnectionState.Disconnected]);
  });
});
