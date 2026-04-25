/**
 * Tests for ost-a8h9: logger injection, error mapping, and plain-text frame handling.
 *
 * Covers PLAN.md §5.3, §5.4, defects D8, D15, D17.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as WS } from "ws";
import { WebSocketServer } from "ws";
import { RateLimitError } from "../../src/errors.js";
import {
  OjinClient,
  type OjinError,
  OjinErrorCode,
  OjinEvent,
  OjinEventEmitter,
  ProtocolError,
} from "../../src/index.js";
import { MessageType } from "../../src/protocol/session-messages.js";
import { createConsoleLogger, type OjinLogger, silent } from "../../src/utils/logger.js";
import * as RedactModule from "../../src/utils/redact.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeLogger(): OjinLogger & {
  debugCalls: string[];
  errorCalls: string[];
  warnCalls: string[];
} {
  const debugCalls: string[] = [];
  const errorCalls: string[] = [];
  const warnCalls: string[] = [];
  return {
    debugCalls,
    errorCalls,
    warnCalls,
    debug(msg) {
      debugCalls.push(msg);
    },
    info() {},
    warn(msg) {
      warnCalls.push(msg);
    },
    error(msg) {
      errorCalls.push(msg);
    },
    isLevelEnabled(level) {
      return level !== "debug"; // enables info/warn/error, blocks debug
    },
  };
}

function makeVerboseLogger(): OjinLogger & {
  debugCalls: string[];
  errorCalls: string[];
} {
  const debugCalls: string[] = [];
  const errorCalls: string[] = [];
  return {
    debugCalls,
    errorCalls,
    debug(msg) {
      debugCalls.push(msg);
    },
    info() {},
    warn() {},
    error(msg) {
      errorCalls.push(msg);
    },
    isLevelEnabled() {
      return true; // all levels enabled
    },
  };
}

// Encodes a JSON object as a WebSocket text frame payload.
function jsonFrame(obj: unknown): string {
  return JSON.stringify(obj);
}

// ── Integration suite (real WS server) ───────────────────────────────────────

describe("OjinClient – logger and error mapping (integration)", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverWs: WS | null = null;

  beforeEach(async () => {
    serverWs = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        const addr = wss.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
    wss.on("connection", (ws) => {
      serverWs = ws;
      // Send sessionReady immediately so client becomes ready
      ws.send(
        jsonFrame({
          type: MessageType.SessionReady,
          payload: {
            traceId: "test",
            status: "success",
            load: 0.5,
            timestamp: Date.now(),
            parameters: {},
          },
        }),
      );
    });
  });

  afterEach(async () => {
    for (const ws of wss.clients) {
      ws.close();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  /** Wait until the server-side WS is captured. */
  async function waitForServer(timeoutMs = 3000): Promise<WS> {
    const deadline = Date.now() + timeoutMs;
    while (serverWs === null) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for server WS");
      await new Promise((r) => setTimeout(r, 10));
    }
    return serverWs;
  }

  /** Wait until client reports isServerReady. */
  async function waitForSessionReady(client: OjinClient, timeoutMs = 3000): Promise<void> {
    if (client.isServerReady) return;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("Timed out waiting for session ready")),
        timeoutMs,
      );
      client.events.on(OjinEvent.SessionReady, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ── Test case 1: RATE_LIMITED → RateLimitError ────────────────────────────

  it("RATE_LIMITED errorResponse emits OjinEvent.Error with RateLimitError", async () => {
    const logger = makeLogger();
    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      configId: "c",
      logger,
    });

    const errPromise = new Promise<OjinError>((resolve) => {
      client.events.on(OjinEvent.Error, resolve);
    });

    await client.connect();
    await waitForSessionReady(client);

    const ws = await waitForServer();
    ws.send(
      jsonFrame({
        type: MessageType.ErrorResponse,
        payload: {
          code: "RATE_LIMITED",
          message: "slow down",
          details: null,
          timestamp: Date.now(),
        },
      }),
    );

    const err = await errPromise;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe(OjinErrorCode.RateLimited);
    expect(err.message).toBe("slow down");

    await client.close();
  });

  // ── Test case 2: plain-text frame → ProtocolError with details.rawMessage ─

  it("plain-text frame emits ProtocolError with details.rawMessage; no console.warn", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn");
    const logger = makeLogger();
    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      configId: "c",
      logger,
    });

    const errPromise = new Promise<OjinError>((resolve) => {
      client.events.on(OjinEvent.Error, resolve);
    });

    await client.connect();
    await waitForSessionReady(client);

    const ws = await waitForServer();
    ws.send("No backend servers available.");

    const err = await errPromise;
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err.code).toBe(OjinErrorCode.ProtocolError);
    expect((err.details as { rawMessage: string }).rawMessage).toBe(
      "No backend servers available.",
    );

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();

    await client.close();
  });

  // ── Test case 3: CANCELLED → no OjinEvent.Error; debug log emitted ────────

  it("CANCELLED errorResponse emits no OjinEvent.Error and logs at debug level", async () => {
    const verboseLogger = makeVerboseLogger();
    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "k",
      configId: "c",
      logger: verboseLogger,
    });

    let errorEmitted = false;
    client.events.on(OjinEvent.Error, () => {
      errorEmitted = true;
    });

    await client.connect();
    await waitForSessionReady(client);

    const ws = await waitForServer();
    ws.send(
      jsonFrame({
        type: MessageType.ErrorResponse,
        payload: {
          code: "CANCELLED",
          message: "interaction cancelled",
          details: null,
          timestamp: Date.now(),
        },
      }),
    );

    // Give the message time to be processed.
    await new Promise((r) => setTimeout(r, 50));

    expect(errorEmitted).toBe(false);
    expect(verboseLogger.debugCalls.some((m) => m.toLowerCase().includes("cancel"))).toBe(true);

    await client.close();
  });
});

// ── Unit suite: OjinEventEmitter logger injection ─────────────────────────────

describe("OjinEventEmitter – logger injection (unit)", () => {
  // ── Test case 4: throwing consumer routes through logger.error ────────────

  it("routes caught handler errors through injected logger.error, not console.error", () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const loggerErrorCalls: string[] = [];
    const testLogger: OjinLogger = {
      debug() {},
      info() {},
      warn() {},
      error(msg) {
        loggerErrorCalls.push(msg);
      },
      isLevelEnabled: () => false,
    };

    const emitter = new OjinEventEmitter(testLogger);
    emitter.on(OjinEvent.ConnectionOpened, () => {
      throw new Error("handler exploded");
    });

    emitter.emit(OjinEvent.ConnectionOpened);

    expect(loggerErrorCalls.length).toBe(1);
    expect(loggerErrorCalls[0]).toMatch(/connection\.opened/);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("silent logger + throwing listener produces zero console output", () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const consoleWarnSpy = vi.spyOn(console, "warn");

    const emitter = new OjinEventEmitter(silent);
    emitter.on(OjinEvent.ConnectionOpened, () => {
      throw new Error("kaboom");
    });

    emitter.emit(OjinEvent.ConnectionOpened);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});

// ── Test case 5: logLevel 'warn' prevents redactMeta from being called ────────
//
// This test is embedded in the integration describe block below so it reuses
// the beforeEach / afterEach WS server setup and the waitForSessionReady helper.

describe("OjinClient – debug guard short-circuit", () => {
  let wss2: WebSocketServer;
  let port2: number;
  let serverWs2: WS | null = null;

  beforeEach(async () => {
    serverWs2 = null;
    wss2 = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss2.on("listening", () => {
        port2 = (wss2.address() as { port: number }).port;
        resolve();
      });
    });
    wss2.on("connection", (ws) => {
      serverWs2 = ws;
      ws.send(
        jsonFrame({
          type: MessageType.SessionReady,
          payload: {
            traceId: "t",
            status: "success",
            load: 0,
            timestamp: Date.now(),
            parameters: {},
          },
        }),
      );
    });
  });

  afterEach(async () => {
    for (const ws of wss2.clients) ws.close();
    await new Promise<void>((resolve) => wss2.close(() => resolve()));
  });

  it("redactMeta is NOT called when logger level is 'warn' (debug suppressed)", async () => {
    const redactMetaSpy = vi.spyOn(RedactModule, "redactMeta");

    const warnLogger = createConsoleLogger("warn");
    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port2}`,
      apiKey: "k",
      configId: "c",
      logger: warnLogger,
    });

    await client.connect();

    // Wait for SessionReady (handles the race: checks isServerReady first).
    if (!client.isServerReady) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for session ready")), 3000);
        client.events.on(OjinEvent.SessionReady, () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    // Clear any calls that happened during the SessionReady frame.
    redactMetaSpy.mockClear();

    // Send a SessionPing; handleMessage reaches the debug guard that wraps redactMeta.
    while (serverWs2 === null) await new Promise((r) => setTimeout(r, 10));
    serverWs2.send(jsonFrame({ type: MessageType.SessionPing }));
    await new Promise((r) => setTimeout(r, 50));

    // With logLevel 'warn', isLevelEnabled('debug') returns false → redactMeta never called.
    expect(redactMetaSpy).not.toHaveBeenCalled();

    await client.close();
    redactMetaSpy.mockRestore();
  });
});
