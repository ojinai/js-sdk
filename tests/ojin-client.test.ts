import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { AuthError, ConnectionError, OjinErrorCode } from "../src/errors.js";
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
import {
  classifyUpgradeFailureByClose,
  classifyUpgradeFailureByStatus,
} from "../src/protocol/error-mapping.js";

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
    });
    await expect(client.connect()).rejects.toThrow();
    expect(client.connectionState).toBe(ConnectionState.Disconnected);
  });
});

// ── HTTP upgrade failure classification (unit tests) ───────────────────────────

describe("classifyUpgradeFailureByStatus", () => {
  it("401 → AuthError(AuthFailed) with details.httpStatus", () => {
    const err = classifyUpgradeFailureByStatus(401);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
    expect((err.details as { httpStatus: number }).httpStatus).toBe(401);
  });

  it("403 → AuthError(AuthFailed) with details.httpStatus", () => {
    const err = classifyUpgradeFailureByStatus(403);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
    expect((err.details as { httpStatus: number }).httpStatus).toBe(403);
  });

  it("500 → ConnectionError(ConnectionFailed) with details.httpStatus", () => {
    const err = classifyUpgradeFailureByStatus(500);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(OjinErrorCode.ConnectionFailed);
    expect((err.details as { httpStatus: number }).httpStatus).toBe(500);
  });

  it("503 → ConnectionError(ConnectionFailed) with details.httpStatus", () => {
    const err = classifyUpgradeFailureByStatus(503);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(OjinErrorCode.ConnectionFailed);
    expect((err.details as { httpStatus: number }).httpStatus).toBe(503);
  });

  it("404 → ConnectionError (not AuthError)", () => {
    expect(classifyUpgradeFailureByStatus(404)).not.toBeInstanceOf(AuthError);
  });
});

describe("classifyUpgradeFailureByClose", () => {
  it("close code 1008 → AuthError(AuthFailed)", () => {
    const err = classifyUpgradeFailureByClose(1008, "Invalid API key");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
    expect((err.details as { closeCode: number }).closeCode).toBe(1008);
    expect((err.details as { closeReason: string }).closeReason).toBe("Invalid API key");
  });

  it("close code 4401 → AuthError(AuthFailed)", () => {
    const err = classifyUpgradeFailureByClose(4401, "");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
  });

  it("close reason 'auth failed' → AuthError(AuthFailed)", () => {
    const err = classifyUpgradeFailureByClose(1000, "auth failed");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
  });

  it("close reason 'unauthorized' → AuthError(AuthFailed)", () => {
    const err = classifyUpgradeFailureByClose(1000, "unauthorized access");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
  });

  it("close reason 'forbidden' → AuthError(AuthFailed)", () => {
    const err = classifyUpgradeFailureByClose(1000, "forbidden");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
  });

  it("close code 1011, 'internal error' → ConnectionError(ConnectionFailed)", () => {
    const err = classifyUpgradeFailureByClose(1011, "internal error");
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(OjinErrorCode.ConnectionFailed);
    expect((err.details as { closeCode: number }).closeCode).toBe(1011);
    expect((err.details as { closeReason: string }).closeReason).toBe("internal error");
  });

  it("close code 1006, empty reason → ConnectionError(ConnectionFailed)", () => {
    const err = classifyUpgradeFailureByClose(1006, "");
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(OjinErrorCode.ConnectionFailed);
  });

  it("close code 1000, benign reason → ConnectionError (not AuthError)", () => {
    expect(classifyUpgradeFailureByClose(1000, "normal close")).not.toBeInstanceOf(AuthError);
  });
});

// ── HTTP upgrade failure integration tests (Node mock server) ─────────────────

describe("OjinClient HTTP upgrade failures", () => {
  /** Start an HTTP server that rejects WS upgrades with the given status. */
  async function startRejectingServer(status: number): Promise<{
    port: number;
    upgradeCount: () => number;
    close: () => Promise<void>;
  }> {
    let count = 0;
    const server = http.createServer();

    server.on("upgrade", (_req, socket) => {
      count++;
      socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Service Unavailable"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    return {
      port,
      upgradeCount: () => count,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  it("401 upgrade → AuthError(AuthFailed) with details.httpStatus", async () => {
    const srv = await startRejectingServer(401);
    try {
      const client = new OjinClient({
        wsUrl: `ws://127.0.0.1:${srv.port}`,
        apiKey: "bad-key",
        configId: "test",
      });

      let caught: Error | null = null;
      try {
        await client.connect();
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeInstanceOf(AuthError);
      expect((caught as AuthError).code).toBe(OjinErrorCode.AuthFailed);
      expect(((caught as AuthError).details as { httpStatus: number }).httpStatus).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("401 upgrade → no retries (AuthError is permanent)", async () => {
    const srv = await startRejectingServer(401);
    try {
      const client = new OjinClient({
        wsUrl: `ws://127.0.0.1:${srv.port}`,
        apiKey: "bad-key",
        configId: "test",
      });

      await client.connect().catch(() => undefined);

      // default reconnectAttempts is 3 but AuthError must not retry
      expect(srv.upgradeCount()).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("503 upgrade → ConnectionError (not AuthError)", async () => {
    const srv = await startRejectingServer(503);
    try {
      const client = new OjinClient({
        wsUrl: `ws://127.0.0.1:${srv.port}`,
        apiKey: "test-key",
        configId: "test",
      });

      let caught: Error | null = null;
      try {
        await client.connect();
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeInstanceOf(AuthError);
      expect(caught).toBeInstanceOf(ConnectionError);
    } finally {
      await srv.close();
    }
  });

  it("503 upgrade → retries ARE attempted for non-auth failures", async () => {
    const expectedAttempts = 3; // matches the hardcoded default reconnectAttempts
    const srv = await startRejectingServer(503);
    try {
      const client = new OjinClient({
        wsUrl: `ws://127.0.0.1:${srv.port}`,
        apiKey: "test-key",
        configId: "test",
      });

      await client.connect().catch(() => undefined);

      expect(srv.upgradeCount()).toBe(expectedAttempts);
    } finally {
      await srv.close();
    }
  });

  it("401 upgrade → client state is Disconnected after rejection", async () => {
    const srv = await startRejectingServer(401);
    try {
      const client = new OjinClient({
        wsUrl: `ws://127.0.0.1:${srv.port}`,
        apiKey: "bad-key",
        configId: "test",
      });

      await client.connect().catch(() => undefined);
      expect(client.connectionState).toBe(ConnectionState.Disconnected);
    } finally {
      await srv.close();
    }
  });
});
