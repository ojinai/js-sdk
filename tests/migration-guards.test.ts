/**
 * Negative-path regression tests for the v0.1 → v1.0 migration guards.
 *
 * Guards live in `assertNoLegacyOptions()` (src/types.ts), called from the
 * `OjinClient` constructor (ost-j8q9 / ost-l1s4).  These tests form the
 * regression net that keeps the guards honest: if a guard is silently removed,
 * renamed, or its error message stops mentioning both the old and new option
 * names, at least one assertion here will fail.
 *
 * Coverage focus:
 *  - migration-guard test requirements
 *  - flat-rename guards
 *  - v1.0 acceptance: migration-guard tests are gating
 */

import { describe, expect, it } from "vitest";
import { ConfigurationError, OjinClient, OjinErrorCode } from "../src/index.js";

// ── Minimal valid base options ────────────────────────────────────────────────

const BASE = {
  wsUrl: "ws://127.0.0.1:1",
  apiKey: "test-key",
  configId: "test-config",
} as const;

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Construct an OjinClient with the base options merged with `extra`.
 * TypeScript is deliberately side-stepped so that we can pass unknown legacy
 * keys and observe the runtime guard.
 */
function buildClient(extra: Record<string, unknown>): OjinClient {
  return new OjinClient({ ...BASE, ...extra } as Parameters<typeof OjinClient>[0]);
}

/**
 * Capture the thrown ConfigurationError from `fn`, or return undefined if it
 * did not throw.  Fails the test if something other than ConfigurationError
 * was thrown.
 */
function catchConfigError(fn: () => unknown): ConfigurationError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected a ConfigurationError to be thrown").toBeInstanceOf(ConfigurationError);
  return caught as ConfigurationError;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("OjinClient migration-guard negative-path tests", () => {
  // ── reconnectDelay ──────────────────────────────────────────────────────────

  describe("reconnectDelay (v0.1 → reconnectBackoff.initialMs)", () => {
    it("throws ConfigurationError when reconnectDelay is supplied", () => {
      expect(() => buildClient({ reconnectDelay: 5 })).toThrow(ConfigurationError);
    });

    it("carries OjinErrorCode.ConfigurationError", () => {
      const err = catchConfigError(() => buildClient({ reconnectDelay: 5 }));
      expect(err.code).toBe(OjinErrorCode.ConfigurationError);
    });

    it("error message names the old option 'reconnectDelay'", () => {
      const err = catchConfigError(() => buildClient({ reconnectDelay: 5 }));
      // Exact substring match — a typo like 'reconnectDealy' in the message
      // would break this assertion.
      expect(err.message).toContain("reconnectDelay");
    });

    it("error message names the new replacement 'reconnectBackoff.initialMs'", () => {
      const err = catchConfigError(() => buildClient({ reconnectDelay: 5 }));
      expect(err.message).toContain("reconnectBackoff.initialMs");
    });
  });

  // ── reconnectAttempts ───────────────────────────────────────────────────────

  describe("reconnectAttempts (v0.1 → initialConnectAttempts / maxReconnectAttempts)", () => {
    it("throws ConfigurationError when reconnectAttempts is supplied", () => {
      expect(() => buildClient({ reconnectAttempts: 3 })).toThrow(ConfigurationError);
    });

    it("carries OjinErrorCode.ConfigurationError", () => {
      const err = catchConfigError(() => buildClient({ reconnectAttempts: 3 }));
      expect(err.code).toBe(OjinErrorCode.ConfigurationError);
    });

    it("error message names the old option 'reconnectAttempts'", () => {
      const err = catchConfigError(() => buildClient({ reconnectAttempts: 3 }));
      expect(err.message).toContain("reconnectAttempts");
    });

    it("error message names both split-counter replacements", () => {
      const err = catchConfigError(() => buildClient({ reconnectAttempts: 3 }));
      // reconnectAttempts was split into two counters; both must be mentioned
      // so consumers know which one to use.
      expect(err.message).toContain("initialConnectAttempts");
      expect(err.message).toContain("maxReconnectAttempts");
    });
  });

  // ── maxQueuedMessages ───────────────────────────────────────────────────────

  describe("maxQueuedMessages (v0.1 → outgoingQueue.maxMessages)", () => {
    it("throws ConfigurationError when maxQueuedMessages is supplied", () => {
      expect(() => buildClient({ maxQueuedMessages: 50 })).toThrow(ConfigurationError);
    });

    it("carries OjinErrorCode.ConfigurationError", () => {
      const err = catchConfigError(() => buildClient({ maxQueuedMessages: 50 }));
      expect(err.code).toBe(OjinErrorCode.ConfigurationError);
    });

    it("error message names the old option 'maxQueuedMessages'", () => {
      const err = catchConfigError(() => buildClient({ maxQueuedMessages: 50 }));
      expect(err.message).toContain("maxQueuedMessages");
    });

    it("error message names the new replacement 'outgoingQueue.maxMessages'", () => {
      const err = catchConfigError(() => buildClient({ maxQueuedMessages: 50 }));
      expect(err.message).toContain("outgoingQueue.maxMessages");
    });
  });

  // ── maxPendingOutgoing ──────────────────────────────────────────────────────

  describe("maxPendingOutgoing (v0.1 → outgoingQueue.maxMessages)", () => {
    it("throws ConfigurationError when maxPendingOutgoing is supplied", () => {
      expect(() => buildClient({ maxPendingOutgoing: 50 })).toThrow(ConfigurationError);
    });

    it("carries OjinErrorCode.ConfigurationError", () => {
      const err = catchConfigError(() => buildClient({ maxPendingOutgoing: 50 }));
      expect(err.code).toBe(OjinErrorCode.ConfigurationError);
    });

    it("error message names the old option 'maxPendingOutgoing'", () => {
      const err = catchConfigError(() => buildClient({ maxPendingOutgoing: 50 }));
      expect(err.message).toContain("maxPendingOutgoing");
    });

    it("error message names the new replacement 'outgoingQueue.maxMessages'", () => {
      const err = catchConfigError(() => buildClient({ maxPendingOutgoing: 50 }));
      expect(err.message).toContain("outgoingQueue.maxMessages");
    });
  });

  // ── Guards are additive: new option names must not throw ───────────────────

  describe("happy-path: v1.0 option names are accepted without error", () => {
    it("outgoingQueue.maxMessages does NOT throw (new v1.0 API)", () => {
      // No WebSocket reachable at port 1, but the constructor must not throw
      // a ConfigurationError — only a connection error would arise from connect().
      expect(() => buildClient({ outgoingQueue: { maxMessages: 50 } })).not.toThrow();
    });

    it("full set of valid v1.0 options does NOT throw", () => {
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
});
