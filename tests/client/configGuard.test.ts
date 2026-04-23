/**
 * Tests for legacy flat-option ConfigurationError guards (ost-j8q9).
 *
 * Covers PLAN.md §11.1 / FE-review finding 16:
 *  - Constructor throws `ConfigurationError` when any v0.1 legacy option is
 *    present: `reconnectDelay`, `reconnectAttempts`, `maxQueuedMessages`,
 *    `maxPendingOutgoing`.
 *  - Each error message names both the old option and its v1.0 replacement.
 *  - The guard is additive: new option names (e.g. `outgoingQueue.maxMessages`)
 *    are accepted without error.
 */

import { describe, expect, it } from "vitest";
import { ConfigurationError, OjinClient, OjinErrorCode } from "../../src/index.js";

// ── Minimal valid base options ────────────────────────────────────────────────

const BASE = {
  wsUrl: "ws://127.0.0.1:1",
  apiKey: "test-key",
  configId: "test-config",
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClient(extra: Record<string, unknown>): OjinClient {
  return new OjinClient({ ...BASE, ...extra } as Parameters<typeof OjinClient>[0]);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("OjinClient legacy-option ConfigurationError guards", () => {
  // ── reconnectDelay ──────────────────────────────────────────────────────────

  it("throws ConfigurationError when reconnectDelay is supplied", () => {
    expect(() => buildClient({ reconnectDelay: 5 })).toThrow(ConfigurationError);
  });

  it("reconnectDelay error names the old option and the new replacement", () => {
    let err: ConfigurationError | undefined;
    try {
      buildClient({ reconnectDelay: 5 });
    } catch (e) {
      if (e instanceof ConfigurationError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/reconnectDelay/);
    expect(err?.message).toMatch(/reconnectBackoff\.initialMs/);
    expect(err?.code).toBe(OjinErrorCode.ConfigurationError);
  });

  // ── reconnectAttempts ───────────────────────────────────────────────────────

  it("throws ConfigurationError when reconnectAttempts is supplied", () => {
    expect(() => buildClient({ reconnectAttempts: 3 })).toThrow(ConfigurationError);
  });

  it("reconnectAttempts error names the old option and the new replacements", () => {
    let err: ConfigurationError | undefined;
    try {
      buildClient({ reconnectAttempts: 3 });
    } catch (e) {
      if (e instanceof ConfigurationError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/reconnectAttempts/);
    expect(err?.message).toMatch(/initialConnectAttempts|maxReconnectAttempts/);
    expect(err?.code).toBe(OjinErrorCode.ConfigurationError);
  });

  // ── maxQueuedMessages ───────────────────────────────────────────────────────

  it("throws ConfigurationError when maxQueuedMessages is supplied", () => {
    expect(() => buildClient({ maxQueuedMessages: 50 })).toThrow(ConfigurationError);
  });

  it("maxQueuedMessages error names the old option and the new replacement", () => {
    let err: ConfigurationError | undefined;
    try {
      buildClient({ maxQueuedMessages: 50 });
    } catch (e) {
      if (e instanceof ConfigurationError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/maxQueuedMessages/);
    expect(err?.message).toMatch(/outgoingQueue\.maxMessages/);
    expect(err?.code).toBe(OjinErrorCode.ConfigurationError);
  });

  // ── maxPendingOutgoing ──────────────────────────────────────────────────────

  it("throws ConfigurationError when maxPendingOutgoing is supplied", () => {
    expect(() => buildClient({ maxPendingOutgoing: 50 })).toThrow(ConfigurationError);
  });

  it("maxPendingOutgoing error names the old option and the new replacement", () => {
    let err: ConfigurationError | undefined;
    try {
      buildClient({ maxPendingOutgoing: 50 });
    } catch (e) {
      if (e instanceof ConfigurationError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/maxPendingOutgoing/);
    expect(err?.message).toMatch(/outgoingQueue\.maxMessages/);
    expect(err?.code).toBe(OjinErrorCode.ConfigurationError);
  });

  // ── Guard is additive: new option names must not throw ──────────────────────

  it("does NOT throw when outgoingQueue.maxMessages is supplied (new API)", () => {
    // No WebSocket is reachable at port 1, but the constructor must not throw
    // a ConfigurationError — only a connection error would come from connect().
    expect(() => buildClient({ outgoingQueue: { maxMessages: 50 } })).not.toThrow();
  });

  it("does NOT throw when only valid v1.0 options are supplied", () => {
    expect(() =>
      buildClient({
        autoWaitForReady: true,
        waitForReadyTimeoutMs: 5_000,
        outgoingQueue: { maxMessages: 10, onOverflow: "dropOldest" },
        heartbeatIntervalMs: 15_000,
        maxRequestsPerSecond: 4,
      }),
    ).not.toThrow();
  });
});
