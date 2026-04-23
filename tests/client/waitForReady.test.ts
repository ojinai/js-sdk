/**
 * Tests for OjinClient.waitForReady(), ReadyTimeoutError, and the
 * session.waiting_for_ready event (ost-g5n1).
 *
 * Covers PLAN.md §4.5:
 *  - Resolves immediately when already ready (cached SessionReady).
 *  - Resolves on the next session.ready event.
 *  - Rejects with ReadyTimeoutError (with details) after timeoutMs.
 *  - Rejects with OjinError(NotConnected) when close() is called during wait.
 *  - Emits session.waiting_for_ready exactly once for concurrent waiters.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import {
  ConnectionState,
  OjinClient,
  OjinError,
  OjinErrorCode,
  OjinEvent,
  OjinSessionReadyMessage,
  ReadyTimeoutError,
} from "../../src/index.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a SessionReady server frame. */
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

/** Wait up to `timeoutMs` ms for `condition()` to return true (polls every 10 ms). */
async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── Shared fixture ─────────────────────────────────────────────────────────────

describe("OjinClient.waitForReady", () => {
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

  function makeClient(): OjinClient {
    return new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      configId: "test-config-id",
    });
  }

  // ── Test 1: resolves after session.ready ────────────────────────────────────

  it("resolves with the SessionReady message when server sends session.ready after 100 ms", {
    timeout: 2000,
  }, async () => {
    // Server sends SessionReady 100 ms after connection.
    wss.on("connection", (ws) => {
      serverWs = ws;
      setTimeout(() => ws.send(sessionReadyFrame({ foo: "bar" })), 100);
    });

    const client = makeClient();
    await client.connect();

    const start = Date.now();
    const msg = await client.waitForReady();

    // Must resolve after ~100 ms, well within 1 s.
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    expect(msg).toBeInstanceOf(OjinSessionReadyMessage);

    await client.close();
  });

  // ── Test 2: timeout → ReadyTimeoutError with details ───────────────────────

  it("rejects with ReadyTimeoutError after timeoutMs when server never sends session.ready", {
    timeout: 2000,
  }, async () => {
    // Server accepts the connection but never sends SessionReady.
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient();
    await client.connect();

    const start = Date.now();
    const err = await client.waitForReady(50).catch((e: unknown) => e);

    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(ReadyTimeoutError);
    expect((err as ReadyTimeoutError).code).toBe(OjinErrorCode.ReadyTimeout);
    expect(elapsed).toBeGreaterThanOrEqual(50);

    const details = (err as ReadyTimeoutError).details as {
      configId: string;
      elapsedMs: number;
      lastConnectionState: ConnectionState;
    };
    expect(details.configId).toBe("test-config-id");
    expect(details.elapsedMs).toBeGreaterThanOrEqual(50);
    // State should be Connected (WS handshake succeeded; server just never
    // sent SessionReady).
    expect(details.lastConnectionState).toBe(ConnectionState.Connected);

    await client.close();
  });

  // ── Test 3: close() during in-flight wait → NotConnected ──────────────────

  it("rejects with OjinError(NotConnected) when close() is called during in-flight wait", {
    timeout: 2000,
  }, async () => {
    // Server accepts but never sends SessionReady.
    wss.on("connection", (ws) => {
      serverWs = ws;
    });

    const client = makeClient();
    await client.connect();

    // Start waiting (will not resolve on its own).
    const readyPromise = client.waitForReady();

    // Close the client while the wait is in flight.
    await client.close();

    const err = await readyPromise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OjinError);
    expect((err as OjinError).code).toBe(OjinErrorCode.NotConnected);
  });

  // ── Test 4: exactly one WaitingForReady event for concurrent waiters ────────

  it("two concurrent waitForReady() calls produce exactly one session.waiting_for_ready event", {
    timeout: 2000,
  }, async () => {
    // Server sends SessionReady after 150 ms, giving us time to start both
    // waits before the event fires.
    wss.on("connection", (ws) => {
      serverWs = ws;
      setTimeout(() => ws.send(sessionReadyFrame()), 150);
    });

    const client = makeClient();
    await client.connect();

    const receivedPayloads: Array<{ configId: string; elapsedMs: number }> = [];
    client.events.on(OjinEvent.WaitingForReady, (payload) => {
      receivedPayloads.push(payload);
    });

    // Start both waitForReady calls without awaiting — they are now concurrent.
    const p1 = client.waitForReady();
    const p2 = client.waitForReady();

    // The event must fire exactly once (synchronously during the second call,
    // the counter is already 1 so no second emission).
    expect(receivedPayloads.length).toBe(1);
    expect(receivedPayloads[0].configId).toBe("test-config-id");
    expect(receivedPayloads[0].elapsedMs).toBe(0);

    // Both promises must resolve once the server sends SessionReady.
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeInstanceOf(OjinSessionReadyMessage);
    expect(r2).toBeInstanceOf(OjinSessionReadyMessage);

    // Still exactly one event.
    expect(receivedPayloads.length).toBe(1);

    await client.close();
  });

  // ── Test 5: resolves immediately if server is already ready ────────────────

  it("resolves immediately (without waiting) when isServerReady is already true", {
    timeout: 2000,
  }, async () => {
    // Server sends SessionReady immediately on connection.
    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    await client.connect();

    // Wait until the client has received and processed the SessionReady frame.
    await waitUntil(() => client.isServerReady);

    // No WaitingForReady event should fire when already ready.
    const waitingEvents: unknown[] = [];
    client.events.on(OjinEvent.WaitingForReady, (p) => waitingEvents.push(p));

    const start = Date.now();
    const msg = await client.waitForReady();
    const elapsed = Date.now() - start;

    expect(msg).toBeInstanceOf(OjinSessionReadyMessage);
    // Must return in under 5 ms (it's a synchronous return).
    expect(elapsed).toBeLessThan(5);
    // No WaitingForReady event because we returned immediately.
    expect(waitingEvents.length).toBe(0);

    await client.close();
  });

  // ── Test 6: _waitingForReadyCount resets after resolution ──────────────────
  //
  // Verifies that a second call to waitForReady() (after the server has
  // already become ready) does NOT emit a WaitingForReady event — the
  // internal counter must have returned to zero after the first resolution.

  it("does not emit WaitingForReady again on a call after the server became ready", {
    timeout: 2000,
  }, async () => {
    let sendReady!: () => void;
    wss.on("connection", (ws) => {
      serverWs = ws;
      sendReady = () => ws.send(sessionReadyFrame());
    });

    const client = makeClient();
    await client.connect();

    // Ensure server connection is established before we trigger SessionReady.
    await waitUntil(() => serverWs !== null);

    const events1: unknown[] = [];
    client.events.on(OjinEvent.WaitingForReady, (p) => events1.push(p));

    // First waitForReady — server is not yet ready so the event fires.
    const p = client.waitForReady();
    expect(events1.length).toBe(1);

    // Trigger SessionReady.
    sendReady();
    await p;

    // Second call — already ready, must return immediately without event.
    const events2: unknown[] = [];
    client.events.on(OjinEvent.WaitingForReady, (p2) => events2.push(p2));
    await client.waitForReady();
    expect(events2.length).toBe(0);

    await client.close();
  });
});
