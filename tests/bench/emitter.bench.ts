import { bench, describe } from "vitest";
import { OjinEvent, OjinEventEmitter } from "../../src/events.js";
import { ConnectionState } from "../../src/types.js";
import { silent } from "../../src/utils/logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Noop listener: cheap enough not to dominate the dispatch measurement. */
const noop = () => {};

/** Reusable payload for ConnectionStateChanged. */
const PAYLOAD = ConnectionState.Connected;

// ─── Dispatch cost by listener count ──────────────────────────────────────────
//
// Each emitter is wired up once before the bench loop starts, so only the
// emit() dispatch itself is measured — not listener registration.

describe("OjinEventEmitter.emit — dispatch cost by listener count", () => {
  for (const count of [0, 1, 10, 100] as const) {
    // Build a fresh emitter with exactly `count` listeners.
    const emitter = new OjinEventEmitter(silent);
    for (let i = 0; i < count; i++) {
      emitter.on(OjinEvent.ConnectionStateChanged, noop);
    }

    // Grammatically correct: "1 listener" (singular), "0/10/100 listeners" (plural).
    const label = `emit ${count} ${count === 1 ? "listener" : "listeners"}`;
    bench(label, () => {
      emitter.emit(OjinEvent.ConnectionStateChanged, PAYLOAD);
    });
  }
});

// ─── Try/catch hot-path: one throwing listener among 99 well-behaved ones ─────
//
// Measures the overhead of the catch branch + logger.error call (silent logger
// is a no-op, so this isolates the try/catch + Error object creation cost).

describe("OjinEventEmitter.emit — catch hot path", () => {
  const emitterWithThrow = new OjinEventEmitter(silent);

  // One listener that always throws.
  emitterWithThrow.on(OjinEvent.ConnectionStateChanged, () => {
    throw new Error("bench-throw");
  });

  // 99 listeners that succeed normally.
  for (let i = 0; i < 99; i++) {
    emitterWithThrow.on(OjinEvent.ConnectionStateChanged, noop);
  }

  bench("emit catch hot path (1 throw + 99 ok)", () => {
    emitterWithThrow.emit(OjinEvent.ConnectionStateChanged, PAYLOAD);
  });
});
