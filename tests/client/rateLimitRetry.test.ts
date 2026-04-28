/**
 * Tests for RATE_LIMITED single-retry with 200 ms backoff (ost-v2y5).
 *
 * Covers retry handling after server-side rate limiting:
 *  - Server RATE_LIMITED once → SDK retries after 200 ms; no RateLimitError event.
 *  - Server RATE_LIMITED twice (for the retry) → RateLimitError event fires.
 *  - close() during the 200 ms retry delay → retry cancelled; no late error events.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import {
  OjinClient,
  OjinErrorCode,
  OjinEvent,
  OjinTextInputMessage,
  RateLimitError,
} from "../../src/index.js";
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

/** Build an ErrorResponse frame with RATE_LIMITED code. */
function rateLimitedFrame(): string {
  return JSON.stringify({
    type: MessageType.ErrorResponse,
    payload: {
      code: OjinErrorCode.RateLimited,
      message: "Rate limit exceeded",
      details: null,
      timestamp: Date.now(),
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

describe("RATE_LIMITED single-retry with 200 ms backoff", () => {
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
      // Disable client-side throttle so messages are dispatched immediately,
      // isolating the test from throttle-queue interactions.
      maxRequestsPerSecond: Infinity,
      ...overrides,
    });
  }

  // ── Test 1: RATE_LIMITED once → retry succeeds → no error event ───────────

  it("RATE_LIMITED once → SDK retries after ~200 ms; no RateLimitError event", {
    timeout: 5000,
  }, async () => {
    let serverReceivedCount = 0;
    const errorEvents: unknown[] = [];

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", () => {
        serverReceivedCount++;
        if (serverReceivedCount === 1) {
          // Reply with RATE_LIMITED to the first message only.
          ws.send(rateLimitedFrame());
        }
        // The second message (retry) is accepted silently — no RATE_LIMITED.
      });
    });

    const client = makeClient();
    client.events.on(OjinEvent.Error, (err) => errorEvents.push(err));

    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs!.send(sessionReadyFrame());
    await waitUntil(() => client.isServerReady);

    // Send one message; the server will respond with RATE_LIMITED.
    void client.sendMessage(new OjinTextInputMessage("hello"));

    // Wait for the server to receive the first message and send RATE_LIMITED.
    await waitUntil(() => serverReceivedCount >= 1);

    // Wait for the 200 ms retry sleep plus margin for the retry to arrive.
    await wait(350);

    // Server must have received the original message AND the retry.
    expect(serverReceivedCount).toBe(2);
    // No error events must have been emitted.
    expect(errorEvents).toHaveLength(0);

    await client.close();
  });

  // ── Test 2: RATE_LIMITED twice → RateLimitError emitted ─────────────────

  it("RATE_LIMITED twice for the same retry → RateLimitError event fires; error.code === RATE_LIMITED", {
    timeout: 5000,
  }, async () => {
    let serverReceivedCount = 0;
    const errorEvents: unknown[] = [];

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", () => {
        serverReceivedCount++;
        // Reply with RATE_LIMITED to every received message (original + retry).
        ws.send(rateLimitedFrame());
      });
    });

    const client = makeClient();
    client.events.on(OjinEvent.Error, (err) => errorEvents.push(err));

    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs!.send(sessionReadyFrame());
    await waitUntil(() => client.isServerReady);

    void client.sendMessage(new OjinTextInputMessage("hello"));

    // Wait for the original message + its RATE_LIMITED response.
    await waitUntil(() => serverReceivedCount >= 1);

    // Wait for the 200 ms retry + the second RATE_LIMITED response + margin.
    await wait(400);

    // Server must have received exactly 2 messages: original + retry.
    expect(serverReceivedCount).toBe(2);
    // Exactly one RateLimitError must have been emitted (after the second failure).
    expect(errorEvents).toHaveLength(1);
    const err = errorEvents[0];
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).code).toBe(OjinErrorCode.RateLimited);

    await client.close();
  });

  // ── Test 3: close() during 200 ms delay → retry cancelled ───────────────

  it("close() during 200 ms retry delay → retry cancelled; no late error events", {
    timeout: 5000,
  }, async () => {
    let serverReceivedCount = 0;
    const errorEvents: unknown[] = [];

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", () => {
        serverReceivedCount++;
        if (serverReceivedCount === 1) {
          ws.send(rateLimitedFrame());
        }
      });
    });

    const client = makeClient();
    client.events.on(OjinEvent.Error, (err) => errorEvents.push(err));

    await client.connect();
    await waitUntil(() => serverWs !== null);

    serverWs!.send(sessionReadyFrame());
    await waitUntil(() => client.isServerReady);

    void client.sendMessage(new OjinTextInputMessage("hello"));

    // Wait for the server to receive the message and send RATE_LIMITED back.
    await waitUntil(() => serverReceivedCount >= 1);
    // Give handleMessage time to process the RATE_LIMITED and start the sleep.
    await wait(50);

    // Close the client while the 200 ms retry sleep is still in progress.
    await client.close();

    // Wait well past the 200 ms window to confirm no retry fires after close().
    await wait(300);

    // Only the original message was received — the retry was cancelled.
    expect(serverReceivedCount).toBe(1);
    // No error events should have been emitted.
    expect(errorEvents).toHaveLength(0);
  });
});
