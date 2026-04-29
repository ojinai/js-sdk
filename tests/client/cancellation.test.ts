/**
 * Cancellation tests for the per-instance AbortController + abortable sleep
 * primitive added to OjinClient (ost-k9r2).
 *
 * These tests verify:
 *  1. close() aborts the in-flight reconnect backoff sleep within the
 *     wall-clock deadline specified in the ticket test cases.
 *  2. sleep() is directly cancellable by close() with no 30 s hang.
 *  3. Fake-timer probe: after close() the cleared abort timer leaves zero
 *     pending timers in the Vitest fake-timer registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ConnectionError, OjinError } from "../../src/errors.js";
import { OjinClient } from "../../src/ojin-client.js";
import { ConnectionState } from "../../src/types.js";

// Narrow helper types so the tests can reach private members without
// casting every access to `unknown`.
interface OjinClientInternals {
  _connectionState: ConnectionState;
  sleep(ms: number): Promise<void>;
}

describe("OjinClient cancellation", () => {
  // ── Shared WS server (accepts connections but never sends SessionReady) ──────

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
  });

  afterEach(async () => {
    for (const ws of wss.clients) ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    vi.useRealTimers();
  });

  // ── Test 1: connect() retry-loop abort ──────────────────────────────────────

  it("close() aborts the in-flight reconnect backoff sleep within 60 ms of close", {
    timeout: 500,
  }, async () => {
    // fail fast if we do hang
    // Point at a port where nothing is listening so the connect attempt fails
    // immediately (ECONNREFUSED), then enters a 1-second backoff sleep
    // (the hardcoded default). close() must cancel that sleep well within 60 ms.
    const client = new OjinClient({
      wsUrl: "ws://127.0.0.1:1",
      apiKey: "test-key",
      configId: "test-config",
      // reconnectAttempts / reconnectDelay removed (legacy — v1.0 uses hardcoded defaults)
    });

    // Kick off connect (it will fail and sleep for ~1 s between retries).
    const connectPromise = client.connect();

    // Abort after 50 ms so connect() has time to enter its retry sleep.
    let closeStartedAt = 0;
    setTimeout(() => {
      closeStartedAt = Date.now();
      void client.close();
    }, 50);

    // connect() must reject (not hang for 10 s).
    await expect(connectPromise).rejects.toThrow();

    // Once close() starts, abort propagation must be prompt.
    expect(closeStartedAt).not.toBe(0);
    expect(Date.now() - closeStartedAt).toBeLessThan(60);
  });

  // ── Test 2: sleep() direct abort ────────────────────────────────────────────

  it("sleep(30_000) is cancelled by close() within 10 ms", { timeout: 200 }, async () => {
    // Connect to the silent WS server (accepts but never sends SessionReady).
    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-key",
      configId: "test-config",
    });

    await client.connect();

    // Reach into the private sleep helper via a typed cast.
    const internals = client as unknown as OjinClientInternals;
    const sleepPromise = internals.sleep(30_000);

    const start = Date.now();
    await client.close();

    // The sleep must have rejected — no 30 s hang.
    await expect(sleepPromise).rejects.toThrow();

    // close() + rejection must both complete within 10 ms of the close call.
    expect(Date.now() - start).toBeLessThan(10);
  });

  // ── Test 3: fake-timer probe — no phantom timers after abort ────────────────

  it("fake timers: zero pending timers after close() aborts sleep", async () => {
    vi.useFakeTimers();

    const client = new OjinClient({
      wsUrl: "ws://127.0.0.1:1",
      apiKey: "test-key",
      configId: "test-config",
    });

    // Force the client to a non-Disconnected state so close() runs its full
    // abort + teardown path instead of returning early.
    (client as unknown as OjinClientInternals)._connectionState = ConnectionState.Connected;

    // Kick off a 30-second sleep — this registers exactly one fake timer.
    const sleepP = (client as unknown as OjinClientInternals).sleep(30_000);

    // close() aborts the controller synchronously, which triggers the abort
    // listener inside sleep(), which calls clearTimeout() on that timer.
    void client.close();

    // Advance by 1 ms.  After the abort the timer was already cleared, so
    // advancing time should not fire anything and the count must be zero.
    vi.advanceTimersByTime(1);

    expect(vi.getTimerCount()).toBe(0);

    // The sleep promise must have rejected (not still pending).
    await expect(sleepP).rejects.toSatisfy(
      (err) => err instanceof OjinError || err instanceof ConnectionError || err instanceof Error,
    );
  });
});
