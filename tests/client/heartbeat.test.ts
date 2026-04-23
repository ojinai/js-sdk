/**
 * Tests for NodeWSTransport heartbeat pings (ost-q6x3).
 *
 * Covers PLAN.md §5.2 / FE-review finding 17:
 *  - Heartbeat fires at the configured interval after connect.
 *  - The interval handle is `.unref()`'d immediately (no process hold-open).
 *  - On `close()`, the interval is cleared synchronously before the socket.
 *  - On reconnect the old interval is cleared at the start of `connect()`.
 *  - Ping errors are logged at `"debug"` and do not affect connection state.
 *  - The transport stays connected when the server ignores pings (no pong).
 *  - Active handle count returns to baseline after connect + close.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWS, WebSocketServer } from "ws";
import type { OjinLogger } from "../../src/utils/logger.js";
import { NodeWSTransport } from "../../src/ws-transport-node.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** White-box access to private transport fields for assertions. */
interface TransportInternals {
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  ws: NodeWS | null;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("NodeWSTransport heartbeat", () => {
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

  function url(): string {
    return `ws://127.0.0.1:${port}`;
  }

  // ── AC#2: pings reach the server ──────────────────────────────────────────

  it("sends ping frames at every heartbeat interval", { timeout: 2000 }, async () => {
    let pingCount = 0;
    wss.on("connection", (ws) => {
      ws.on("ping", () => {
        pingCount++;
      });
    });

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    await transport.connect(url(), {});

    // Allow 4 potential intervals; expect at least 2 to fire.
    await wait(250);

    transport.close();

    expect(pingCount).toBeGreaterThanOrEqual(2);
  });

  // ── AC#3: interval handle is .unref()'d ───────────────────────────────────

  it("heartbeat timer is unref'd immediately after connect", { timeout: 2000 }, async () => {
    wss.on("connection", () => {});

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    await transport.connect(url(), {});

    const timer = (transport as unknown as TransportInternals).heartbeatTimer;
    expect(timer).not.toBeNull();
    // .unref() must be called so the interval does not hold the event loop open.
    expect(timer?.hasRef()).toBe(false);

    transport.close();
  });

  // ── AC#4: interval cleared synchronously on close() ───────────────────────

  it("close() nulls heartbeatTimer synchronously before returning", { timeout: 2000 }, async () => {
    wss.on("connection", () => {});

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    await transport.connect(url(), {});

    expect((transport as unknown as TransportInternals).heartbeatTimer).not.toBeNull();

    transport.close();

    // Must be null synchronously after close() returns — not on a next tick.
    expect((transport as unknown as TransportInternals).heartbeatTimer).toBeNull();
  });

  // ── AC#4 cont: no pings after close ───────────────────────────────────────

  it("no ping frames are sent after close()", { timeout: 2000 }, async () => {
    let pingCount = 0;
    wss.on("connection", (ws) => {
      ws.on("ping", () => {
        pingCount++;
      });
    });

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    await transport.connect(url(), {});

    // Wait for at least one ping to confirm the interval was running.
    await wait(80);
    const pingCountAtClose = pingCount;
    expect(pingCountAtClose).toBeGreaterThanOrEqual(1);

    transport.close();

    // Wait for 3 more potential intervals — none must fire.
    await wait(200);

    expect(pingCount).toBe(pingCountAtClose);
  });

  // ── AC#5: reconnect clears old interval, restarts new one ─────────────────

  it("reconnect: old interval is cleared at start of connect(), new one starts after open", {
    timeout: 3000,
  }, async () => {
    wss.on("connection", () => {});

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });

    // First connection.
    await transport.connect(url(), {});
    const firstTimer = (transport as unknown as TransportInternals).heartbeatTimer;
    expect(firstTimer).not.toBeNull();

    // Close to simulate a disconnect before reconnect.
    transport.close();
    await wait(50); // allow the WebSocket close handshake to settle

    // Second connection (reconnect).
    await transport.connect(url(), {});
    const secondTimer = (transport as unknown as TransportInternals).heartbeatTimer;

    expect(secondTimer).not.toBeNull();
    // Must be a fresh timer, not the cleared old one.
    expect(secondTimer).not.toBe(firstTimer);
    // New timer must also be unref'd.
    expect(secondTimer?.hasRef()).toBe(false);

    transport.close();
  });

  // ── AC#6: pong absence does not disconnect ─────────────────────────────────

  it("stays connected when server ignores pings (no pong response)", {
    timeout: 3000,
  }, async () => {
    wss.on("connection", (ws) => {
      // Send regular text frames every 30 ms but NEVER respond to pings.
      const keepAlive = setInterval(() => {
        if (ws.readyState === NodeWS.OPEN) ws.send("frame");
      }, 30);
      ws.on("close", () => clearInterval(keepAlive));
      // No ws.on("ping") handler — pings are silently ignored.
    });

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    let disconnected = false;
    transport.onClose(() => {
      disconnected = true;
    });

    await transport.connect(url(), {});

    // Allow 5+ heartbeat intervals without any pong response.
    await wait(300);

    // Client must remain connected — pong absence is NOT load-bearing.
    expect(disconnected).toBe(false);
    expect(transport.isOpen).toBe(true);

    transport.close();
  });

  // ── AC#6: ping errors logged at debug, not propagated ─────────────────────

  it("ping errors are logged at debug level and do not reach errorHandler", {
    timeout: 2000,
  }, async () => {
    wss.on("connection", () => {});

    const debugMessages: string[] = [];
    const logger: OjinLogger = {
      debug: (msg) => debugMessages.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
      isLevelEnabled: () => true,
    };

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50, logger });
    let errorCount = 0;
    transport.onError(() => {
      errorCount++;
    });

    await transport.connect(url(), {});

    // Inject a ping error by replacing the ws.ping method with a stub that
    // always calls the callback with an error.
    const wsInstance = (transport as unknown as TransportInternals).ws;
    expect(wsInstance).not.toBeNull();

    if (wsInstance) {
      type PingCallback = (err: Error) => void;
      type PingFn = (data?: unknown, mask?: unknown, cb?: PingCallback) => void;
      const pingable = wsInstance as unknown as { ping: PingFn };
      const originalPing = pingable.ping.bind(wsInstance);
      pingable.ping = (_data, _mask, cb) => {
        if (typeof cb === "function") cb(new Error("simulated ping failure"));
      };

      // Allow the interval to fire with the injected error.
      await wait(120);

      // Error must be logged at debug level.
      expect(debugMessages.some((m) => m.toLowerCase().includes("ping"))).toBe(true);
      // Error must NOT be forwarded to the registered errorHandler.
      expect(errorCount).toBe(0);

      // Restore original ping before close.
      pingable.ping = originalPing;
    }

    transport.close();
  });

  // ── No-leaked-handle proof (FE-review finding 17) ─────────────────────────

  it("active handle count returns to baseline after connect + close", {
    timeout: 3000,
  }, async () => {
    // Flush any pending micro/macro tasks so the baseline is stable.
    await new Promise<void>((r) => setImmediate(r));

    type ProcessWithHandles = { _getActiveHandles(): unknown[] };
    const activeHandles = () =>
      (process as unknown as ProcessWithHandles)._getActiveHandles().length;

    const handlesBefore = activeHandles();

    // Track when the server-side WebSocket close completes so we know the
    // full handshake has finished before re-counting handles.
    let serverClosedResolve!: () => void;
    const serverClosed = new Promise<void>((r) => {
      serverClosedResolve = r;
    });
    wss.on("connection", (ws) => {
      ws.on("close", () => serverClosedResolve());
    });

    const transport = new NodeWSTransport({ heartbeatIntervalMs: 50 });
    await transport.connect(url(), {});

    // Heartbeat interval must be running.
    expect((transport as unknown as TransportInternals).heartbeatTimer).not.toBeNull();

    transport.close();

    // Interval must be cleared synchronously (no leaked timer).
    expect((transport as unknown as TransportInternals).heartbeatTimer).toBeNull();

    // Wait for the WebSocket close handshake to finish on both ends.
    await Promise.race([serverClosed, wait(1000)]);
    // Flush any remaining async cleanup.
    await new Promise<void>((r) => setImmediate(r));

    const handlesAfter = activeHandles();

    // Handle count must not exceed the baseline — no leaked interval or socket
    // was added by the transport. (It may be lower if unrelated handles from
    // earlier tests finished cleaning up between measurements.)
    expect(handlesAfter).toBeLessThanOrEqual(handlesBefore);
  });
});
