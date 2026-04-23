/**
 * Tests for the autoWaitForReady option and pre-ready message buffer (ost-h6o3).
 *
 * Covers PLAN.md §4.5 / FE-review finding 5:
 *  - Default (autoWaitForReady: false) — sendMessage throws ConnectionError
 *    immediately when the inference server is not yet ready (v0.1 semantics).
 *  - autoWaitForReady: true — three messages queued before session.ready are
 *    flushed to the server in exact call order once the server becomes ready.
 *  - autoWaitForReady: true — sendMessage rejects with ReadyTimeoutError if the
 *    server never sends session.ready within waitForReadyTimeoutMs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import {
  ConnectionError,
  ConnectionState,
  OjinClient,
  OjinErrorCode,
  OjinTextInputMessage,
  ReadyTimeoutError,
} from "../../src/index.js";
import { deserializeInteractionInputMessage } from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a well-formed SessionReady server frame. */
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

/** Wait up to `timeoutMs` ms for `condition()` to return true (polls every 10 ms). */
async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── Shared fixture ────────────────────────────────────────────────────────────

describe("autoWaitForReady option", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverWs: WS | null = null;

  beforeEach(async () => {
    serverWs = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        port = (wss.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const ws of wss.clients) ws.close();
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

  // ── Test 1: default behavior — throw immediately ──────────────────────────

  it("default (autoWaitForReady: false) — sendMessage rejects with ServerNotReady when server not yet ready", {
    timeout: 2000,
  }, async () => {
    // Server accepts the connection but never sends SessionReady, so the
    // client's _inferenceServerReady flag stays false.
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient(); // autoWaitForReady defaults to false
    await client.connect();

    expect(client.isServerReady).toBe(false);

    // sendMessage must reject with a ConnectionError(ServerNotReady) — no
    // buffering, no waiting for session.ready.
    const msg = new OjinTextInputMessage("hello");
    const err = await client.sendMessage(msg).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).code).toBe(OjinErrorCode.ServerNotReady);

    await client.close();
  });

  // ── Test 2: autoWaitForReady: true — flush in call order ─────────────────
  //
  // Three sendMessage() calls made before session.ready must reach the server
  // in the same order they were enqueued once session.ready fires.

  it("autoWaitForReady: true — three sendMessage calls before session.ready are flushed to the server in exact call order", {
    timeout: 5000,
  }, async () => {
    const received: string[] = [];

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          try {
            const msg = deserializeInteractionInputMessage(new Uint8Array(data));
            received.push(new TextDecoder().decode(msg.payload.payload));
          } catch {
            // ignore malformed frames
          }
        }
      });
    });

    const client = makeClient({ autoWaitForReady: true });
    await client.connect();

    // Ensure the server-side connection handler has fired before we proceed.
    await waitUntil(() => serverWs !== null);

    expect(client.isServerReady).toBe(false);

    // Enqueue three messages before session.ready fires; none of them
    // should reach the server yet.
    const p1 = client.sendMessage(new OjinTextInputMessage("msg-1"));
    const p2 = client.sendMessage(new OjinTextInputMessage("msg-2"));
    const p3 = client.sendMessage(new OjinTextInputMessage("msg-3"));

    // Trigger session.ready from the server side.
    serverWs?.send(sessionReadyFrame());

    // All three Promises must resolve once the queue is flushed.
    await Promise.all([p1, p2, p3]);

    // Allow the server's message handlers to process the incoming frames.
    await waitUntil(() => received.length >= 3, 2000);

    expect(received).toEqual(["msg-1", "msg-2", "msg-3"]);

    await client.close();
  });

  // ── Test 3: autoWaitForReady: true — timeout ──────────────────────────────
  //
  // If session.ready never arrives within waitForReadyTimeoutMs, sendMessage
  // must reject with ReadyTimeoutError carrying the expected details.

  it("autoWaitForReady: true — sendMessage rejects with ReadyTimeoutError after waitForReadyTimeoutMs with no session.ready", {
    timeout: 5000,
  }, async () => {
    // Server accepts connection but never sends SessionReady.
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    // Short timeout so the test does not run for 10 seconds.
    const client = makeClient({
      autoWaitForReady: true,
      waitForReadyTimeoutMs: 50,
    });
    await client.connect();

    expect(client.isServerReady).toBe(false);

    const msg = new OjinTextInputMessage("will-timeout");
    const err = await client.sendMessage(msg).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReadyTimeoutError);
    expect((err as ReadyTimeoutError).code).toBe(OjinErrorCode.ReadyTimeout);

    const details = (err as ReadyTimeoutError).details as {
      configId: string;
      elapsedMs: number;
      lastConnectionState: ConnectionState;
    };
    expect(details.configId).toBe("test-config-id");
    expect(details.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(details.lastConnectionState).toBe(ConnectionState.Connected);

    await client.close();
  });
});
