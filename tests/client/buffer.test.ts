/**
 * Tests for the outgoingQueue config and QueueFullError overflow modes (ost-i7p5).
 *
 * Covers outgoing queue overflow and reconnect-flush behavior:
 *  - onOverflow: "reject" (default) — 3rd send into a maxMessages:2 queue
 *    rejects with QueueFullError carrying queueDepth and maxMessages details.
 *  - onOverflow: "dropOldest" — oldest buffered message is ejected when the
 *    queue is full; queue.overflow event fires at most 1× per 5 s; the server
 *    receives the 100 newest messages after session.ready.
 *  - QueueFullError instanceof OjinError → true.
 *  - Reconnect-flush: messages buffered before the first session.ready are
 *    preserved across a transport drop and flushed on the fresh session.ready.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import {
  OjinClient,
  OjinError,
  OjinErrorCode,
  OjinEvent,
  OjinTextInputMessage,
  QueueFullError,
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

describe("outgoingQueue config + QueueFullError overflow modes", () => {
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

  // ── Test 1: onOverflow: "reject" — 3rd send rejects with QueueFullError ────
  //
  // With maxMessages:2, the third concurrent sendMessage call (before any
  // session.ready) must reject with QueueFullError(QueueFull) carrying
  // details.queueDepth=2 and details.maxMessages=2.

  it('onOverflow: "reject" — 3rd send into maxMessages:2 queue rejects with QueueFullError(queueDepth:2, maxMessages:2)', {
    timeout: 5000,
  }, async () => {
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient({
      autoWaitForReady: true,
      outgoingQueue: { maxMessages: 2, onOverflow: "reject" },
    });
    await client.connect();
    await waitUntil(() => serverWs !== null);

    // Enqueue 2 messages — both should be buffered without error.
    const p1 = client.sendMessage(new OjinTextInputMessage("msg-1"));
    const p2 = client.sendMessage(new OjinTextInputMessage("msg-2"));

    // The 3rd message exceeds the limit and must reject immediately.
    const err = await client
      .sendMessage(new OjinTextInputMessage("msg-3"))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueueFullError);
    expect(err).toBeInstanceOf(OjinError);
    expect((err as QueueFullError).code).toBe(OjinErrorCode.QueueFull);

    const details = (err as QueueFullError).details as {
      queueDepth: number;
      maxMessages: number;
    };
    expect(details.queueDepth).toBe(2);
    expect(details.maxMessages).toBe(2);

    // Tidy up: trigger session.ready so the 2 queued promises can resolve.
    serverWs?.send(sessionReadyFrame());
    await Promise.all([p1, p2]);

    await client.close();
  });

  // ── Test 2: QueueFullError instanceof OjinError → true ───────────────────

  it("QueueFullError instanceof OjinError → true", () => {
    const err = new QueueFullError(OjinErrorCode.QueueFull, "test", {
      queueDepth: 1,
      maxMessages: 1,
    });
    expect(err).toBeInstanceOf(QueueFullError);
    expect(err).toBeInstanceOf(OjinError);
    expect(err).toBeInstanceOf(Error);
  });

  // ── Test 3: onOverflow: "dropOldest" — 1000 sends, 900 dropped ───────────
  //
  // With maxMessages:100 and dropOldest, firing 1000 sendMessage calls before
  // session.ready causes the oldest 900 to be ejected (their promises reject
  // with QueueFullError). The queue.overflow event fires at most once in the
  // 5-second window.  After session.ready, the server receives the 100 newest
  // messages in the exact order they were originally sent.

  it('onOverflow: "dropOldest" — 1000 sends → 900 dropped, queue.overflow at most 1× per 5s, server receives 100 newest', {
    timeout: 10_000,
  }, async () => {
    const received: string[] = [];
    let overflowEventCount = 0;

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

    const client = makeClient({
      autoWaitForReady: true,
      // Disable rate throttle so all 100 queued messages flush without delay.
      maxRequestsPerSecond: Infinity,
      outgoingQueue: { maxMessages: 100, onOverflow: "dropOldest" },
    });

    client.events.on(OjinEvent.QueueOverflow, () => {
      overflowEventCount++;
    });

    await client.connect();
    await waitUntil(() => serverWs !== null);

    // Fire 1000 sends synchronously.  Sends 1–100 fill the queue; each
    // subsequent send ejects the oldest and enqueues the new message.
    const promises = Array.from({ length: 1000 }, (_, i) =>
      client.sendMessage(new OjinTextInputMessage(`msg-${i + 1}`)),
    );

    // Trigger session.ready to flush the 100 queued messages.
    serverWs?.send(sessionReadyFrame());

    // Await all promises (900 reject, 100 resolve).
    const results = await Promise.allSettled(promises);

    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");

    // 900 messages were dropped — their sendMessage calls rejected.
    expect(rejected).toHaveLength(900);
    // 100 messages were sent to the server — their promises resolved.
    expect(fulfilled).toHaveLength(100);

    // All rejected entries must carry QueueFullError(QueueFull).
    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(QueueFullError);
        expect((r.reason as QueueFullError).code).toBe(OjinErrorCode.QueueFull);
      }
    }

    // Server receives the 100 newest messages (msg-901 … msg-1000).
    await waitUntil(() => received.length >= 100, 5000);
    expect(received).toHaveLength(100);
    expect(received[0]).toBe("msg-901");
    expect(received[99]).toBe("msg-1000");

    // queue.overflow must have fired at most once (5-second rate limit).
    expect(overflowEventCount).toBe(1);

    await client.close();
  });

  // ── Test 4: reconnect-flush — queue preserved across transport drop ────────
  //
  // Messages buffered before the server's first session.ready must survive a
  // server-side connection drop and be flushed when session.ready is received
  // on the fresh reconnected transport.

  it("reconnect-flush: pre-ready messages buffered before a transport drop are flushed on the fresh session.ready", {
    timeout: 8000,
  }, async () => {
    const received: string[] = [];
    let connectionCount = 0;
    let latestServerWs: WS | null = null;

    wss.on("connection", (ws) => {
      connectionCount++;
      latestServerWs = ws;
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          try {
            const msg = deserializeInteractionInputMessage(new Uint8Array(data));
            received.push(new TextDecoder().decode(msg.payload.payload));
          } catch {
            // ignore
          }
        }
      });
    });

    const client = makeClient({
      autoWaitForReady: true,
      maxRequestsPerSecond: Infinity,
    });

    await client.connect();
    await waitUntil(() => connectionCount >= 1);

    // Enqueue messages BEFORE session.ready — they go into the pre-ready buffer.
    const p1 = client.sendMessage(new OjinTextInputMessage("buffered-1"));
    const p2 = client.sendMessage(new OjinTextInputMessage("buffered-2"));

    // Server drops the connection without ever sending session.ready.
    latestServerWs?.terminate();
    await waitUntil(() => connectionCount >= 2, 3000);

    // The pre-ready buffer must still contain the two pending messages.
    expect(received).toHaveLength(0);

    // Server sends session.ready on the new connection — queue must flush.
    latestServerWs?.send(sessionReadyFrame());

    // Both pending promises must resolve.
    await Promise.all([p1, p2]);

    // Both messages must arrive at the server in call order.
    await waitUntil(() => received.length >= 2, 3000);
    expect(received).toEqual(["buffered-1", "buffered-2"]);

    await client.close();
  });
});
