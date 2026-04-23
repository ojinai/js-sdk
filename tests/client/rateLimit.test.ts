/**
 * Tests for the maxRequestsPerSecond client-side throttle (ost-u1x4).
 *
 * Covers PLAN.md §5.4 / FE-review finding 24:
 *  - Default throttle (6 req/sec) limits outbound messages to at most 6 per
 *    rolling 1-second window; excess calls are buffered in the throttle queue.
 *  - maxRequestsPerSecond: Infinity disables throttling entirely.
 *  - connection.opened resets the throttle budget to 0 so that every new
 *    transport connection starts with a full budget (not inheriting exhausted
 *    budget from the previous connection).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import { OjinClient, OjinTextInputMessage } from "../../src/index.js";
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

/** Sleep for `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Shared fixture ────────────────────────────────────────────────────────────

describe("maxRequestsPerSecond throttle", () => {
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

  // ── Test 1: default throttle (6/sec) ──────────────────────────────────────
  //
  // Issuing 100 sendMessage calls within a single JS turn should result in
  // at most 6 messages being transmitted within the first ~50 ms (well within
  // the 1-second window).  The remaining 94 stay in the throttle queue until
  // the window resets.

  it("default throttle: 100 sendMessage calls → at most 6 transmitted in first window", {
    timeout: 5000,
  }, async () => {
    let receivedCount = 0;

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", () => {
        receivedCount++;
      });
    });

    const client = makeClient(); // default maxRequestsPerSecond: 6
    await client.connect();
    await waitUntil(() => serverWs !== null);

    // Trigger session.ready so sendMessage is unblocked.
    serverWs?.send(sessionReadyFrame());
    await waitUntil(() => client.isServerReady);

    // Fire 100 sendMessage calls without awaiting; only 6 should leave the
    // client within the first 1-second window.
    const promises = Array.from({ length: 100 }, () =>
      client.sendMessage(new OjinTextInputMessage("msg")),
    );

    // Wait 100 ms — enough time for 6 messages to arrive over loopback but
    // well under the 1 000 ms throttle window reset.
    await wait(100);

    expect(receivedCount).toBeLessThanOrEqual(6);
    expect(receivedCount).toBeGreaterThanOrEqual(1);

    // Tidy up: close the client (this rejects the 94 queued promises).
    await client.close();

    // Some promises will reject (throttle-queued ones that were rejected by
    // close()); that is the expected behaviour — just drain them.
    await Promise.allSettled(promises);
  });

  // ── Test 2: Infinity disables throttle ────────────────────────────────────
  //
  // When maxRequestsPerSecond is Infinity all messages should be dispatched
  // synchronously with no queuing at all.

  it("maxRequestsPerSecond: Infinity → all messages sent immediately, no throttle", {
    timeout: 5000,
  }, async () => {
    const msgCount = 20;
    let receivedCount = 0;

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", () => {
        receivedCount++;
      });
    });

    const client = makeClient({ maxRequestsPerSecond: Infinity });
    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs?.send(sessionReadyFrame());
    await waitUntil(() => client.isServerReady);

    // Issue all messages synchronously.
    const promises = Array.from({ length: msgCount }, () =>
      client.sendMessage(new OjinTextInputMessage("msg")),
    );

    // All promises must resolve (none were queued).
    await Promise.all(promises);

    // All messages should arrive at the server within a short round-trip.
    await waitUntil(() => receivedCount >= msgCount, 2000);
    expect(receivedCount).toBe(msgCount);

    await client.close();
  });

  // ── Test 3: connection.opened resets budget ───────────────────────────────
  //
  // After exhausting the throttle budget on one connection, a reconnect must
  // reset the budget to 0 so the new connection can immediately send up to
  // maxRequestsPerSecond messages without being throttled.

  it("connection.opened resets throttle budget — reconnect starts with full budget", {
    timeout: 8000,
  }, async () => {
    const RPS = 6;
    let receivedCount = 0;
    let serverConnections = 0;

    wss.on("connection", (ws) => {
      serverWs = ws;
      serverConnections++;
      ws.on("message", () => {
        receivedCount++;
      });
      // Auto-send session.ready for every new connection.
      ws.send(sessionReadyFrame());
    });

    // ── First connection: exhaust the 6-message budget ──────────────────────
    const client = makeClient({ maxRequestsPerSecond: RPS });
    await client.connect();
    await waitUntil(() => serverConnections >= 1);
    await waitUntil(() => client.isServerReady);

    // Send exactly RPS messages to fill the throttle window.
    const firstBatch = Array.from({ length: RPS }, () =>
      client.sendMessage(new OjinTextInputMessage("first")),
    );
    await Promise.all(firstBatch);

    // Verify all RPS messages were transmitted.
    await waitUntil(() => receivedCount >= RPS, 2000);
    expect(receivedCount).toBe(RPS);

    // Record how many messages have been received before the reconnect.
    const afterFirstBatch = receivedCount;

    // ── Disconnect ──────────────────────────────────────────────────────────
    await client.close();
    // Allow the WebSocket close handshake to complete on both ends before
    // opening a new connection. Without this wait the old transport's async
    // close event can race with the new transport's connect() and accidentally
    // null out this.transport (pre-existing race; cf. heartbeat.test.ts).
    await wait(100);

    // ── Reconnect — budget must be reset by connection.opened ───────────────
    await client.connect();
    await waitUntil(() => serverConnections >= 2);
    await waitUntil(() => client.isServerReady);

    // Send RPS messages immediately.  If the budget was NOT reset these
    // messages would be throttled (queued for ~1 s).  If it WAS reset they
    // arrive within milliseconds.
    const secondBatch = Array.from({ length: RPS }, () =>
      client.sendMessage(new OjinTextInputMessage("second")),
    );

    // All promises must resolve quickly — they should not be throttled.
    await Promise.all(secondBatch);

    // All messages from the second batch must arrive at the server within
    // a short round-trip window (not a 1-second throttle delay).
    await waitUntil(() => receivedCount >= afterFirstBatch + RPS, 500);
    expect(receivedCount).toBe(afterFirstBatch + RPS);

    await client.close();
  });
});
