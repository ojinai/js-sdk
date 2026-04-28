/**
 * Tests for `computeBackoff` (ost-l1s4).
 *
 * Covers exponential backoff behavior:
 *  - All computed delays at attempt N fall within the expected jitter envelope.
 *  - Values are statistically spread (jitter is exercised, not collapsed).
 *  - The delay caps at `maxMs` once the nominal exceeds the ceiling.
 *  - A seeded PRNG produces fully deterministic output.
 */

import { describe, expect, it } from "vitest";
import { computeBackoff, DEFAULT_RECONNECT_BACKOFF } from "../../src/utils/backoff.js";

// ── Simple LCG for reproducible seeding ──────────────────────────────────────

/**
 * Minimal 32-bit LCG (Knuth / MMIX coefficients).
 * Returns a factory so each test gets its own independent counter.
 */
function makeSeededRandom(seed: number): () => number {
  let s = seed >>> 0; // ensure unsigned 32-bit
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    s >>>= 0; // keep unsigned
    return s / 0x1_0000_0000;
  };
}

// ── Shorthand ─────────────────────────────────────────────────────────────────

const DEFAULTS = DEFAULT_RECONNECT_BACKOFF;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("computeBackoff — jitter envelope", () => {
  /**
   * AC test-case 1: 100 samples at attempt 3 with defaults must all lie in
   * [500 × 2^3 × 0.7, 500 × 2^3 × 1.3] = [2800, 5200] ms.
   */
  it("all 100 samples at attempt 3 fall within [2800, 5200] ms", () => {
    // nominal = min(500 * 8, 30_000) = 4000
    const lo = 500 * 2 ** 3 * (1 - DEFAULTS.jitter); // 2800
    const hi = 500 * 2 ** 3 * (1 + DEFAULTS.jitter); // 5200

    for (let i = 0; i < 100; i++) {
      const v = computeBackoff(3, DEFAULTS);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  /**
   * AC test-case 1b: statistical spread ≥ 10 % of nominal (400 ms).
   * With 100 samples from a uniform distribution over a 2400 ms range, the
   * probability that max−min < 400 ms is (400/2400)^100 ≈ 10^−78 — safe.
   */
  it("100 samples at attempt 3 have spread ≥ 10 % of nominal (≥ 400 ms)", () => {
    const nominal = 500 * 2 ** 3; // 4000
    const samples = Array.from({ length: 100 }, () => computeBackoff(3, DEFAULTS));
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeGreaterThanOrEqual(nominal * 0.1); // ≥ 400 ms
  });
});

describe("computeBackoff — maxMs cap", () => {
  /**
   * AC test-case 2: by attempt 7+, the nominal saturates at maxMs so the
   * midpoint (random = 0.5 → factor = 1.0) equals exactly maxMs.
   *
   * factor = 1 − 0.3 + 2 × 0.3 × 0.5 = 0.7 + 0.3 = 1.0
   * delay  = maxMs × 1.0 = 30 000
   */
  it("midpoint at attempt 7 equals maxMs exactly", () => {
    const mid = computeBackoff(7, DEFAULTS, () => 0.5);
    expect(mid).toBe(DEFAULTS.maxMs);
  });

  it("midpoint at attempt 10 equals maxMs exactly (ceiling is stable)", () => {
    const mid = computeBackoff(10, DEFAULTS, () => 0.5);
    expect(mid).toBe(DEFAULTS.maxMs);
  });

  it("even the lower jitter bound at attempt 7 is ≤ maxMs", () => {
    // random = 0 → factor = 1 − jitter = 0.7 → delay = maxMs × 0.7 ≤ maxMs
    const lower = computeBackoff(7, DEFAULTS, () => 0);
    expect(lower).toBeLessThanOrEqual(DEFAULTS.maxMs);
    expect(lower).toBeGreaterThan(0);
  });

  it("cap kicks in before attempt 7 (attempt 6 is already saturated)", () => {
    // 500 × 2^6 = 32 000 > 30 000 → nominal = 30 000
    const mid = computeBackoff(6, DEFAULTS, () => 0.5);
    expect(mid).toBe(DEFAULTS.maxMs);
  });

  it("attempt 5 is NOT capped (500 × 32 = 16 000 < 30 000)", () => {
    const mid = computeBackoff(5, DEFAULTS, () => 0.5);
    expect(mid).toBe(500 * 2 ** 5); // 16 000
  });
});

describe("computeBackoff — determinism", () => {
  /**
   * AC §6: a seeded PRNG produces identical output across two independent
   * streams initialised with the same seed.
   */
  it("is fully deterministic with a fixed-seed PRNG", () => {
    const SEED = 42;
    const attempts = 12;

    const r1 = makeSeededRandom(SEED);
    const r2 = makeSeededRandom(SEED);

    const run1 = Array.from({ length: attempts }, (_, i) => computeBackoff(i, DEFAULTS, r1));
    const run2 = Array.from({ length: attempts }, (_, i) => computeBackoff(i, DEFAULTS, r2));

    expect(run1).toEqual(run2);
  });

  it("different seeds produce different output (PRNG is exercised)", () => {
    const r42 = makeSeededRandom(42);
    const r99 = makeSeededRandom(99);

    const v42 = computeBackoff(3, DEFAULTS, r42);
    const v99 = computeBackoff(3, DEFAULTS, r99);

    expect(v42).not.toBe(v99);
  });
});

describe("computeBackoff — attempt 0 (initial seed)", () => {
  it("attempt 0 is within [initialMs × (1−jitter), initialMs × (1+jitter)]", () => {
    const lo = DEFAULTS.initialMs * (1 - DEFAULTS.jitter); // 350
    const hi = DEFAULTS.initialMs * (1 + DEFAULTS.jitter); // 650

    for (let i = 0; i < 20; i++) {
      const v = computeBackoff(0, DEFAULTS);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  it("attempt 0 midpoint equals initialMs exactly (random = 0.5)", () => {
    expect(computeBackoff(0, DEFAULTS, () => 0.5)).toBe(DEFAULTS.initialMs);
  });
});

describe("computeBackoff — custom config", () => {
  it("respects a custom multiplier", () => {
    const config = { initialMs: 100, maxMs: 10_000, multiplier: 3, jitter: 0 };
    // jitter = 0 → factor always 1
    expect(computeBackoff(0, config, () => 0.5)).toBe(100);
    expect(computeBackoff(1, config, () => 0.5)).toBe(300);
    expect(computeBackoff(2, config, () => 0.5)).toBe(900);
    expect(computeBackoff(3, config, () => 0.5)).toBe(2700);
    expect(computeBackoff(4, config, () => 0.5)).toBe(8100);
    // 100 × 3^5 = 24 300 > 10 000 → capped
    expect(computeBackoff(5, config, () => 0.5)).toBe(10_000);
  });

  it("zero jitter produces the exact nominal value", () => {
    const config = { initialMs: 200, maxMs: 5_000, multiplier: 2, jitter: 0 };
    for (let attempt = 0; attempt < 8; attempt++) {
      const nominal = Math.min(200 * 2 ** attempt, 5_000);
      expect(computeBackoff(attempt, config)).toBe(nominal);
    }
  });

  it("jitter 0.5: random=0 gives half nominal, random=1 gives 1.5× nominal", () => {
    const config = { initialMs: 1_000, maxMs: 60_000, multiplier: 1, jitter: 0.5 };
    // nominal = 1 000 always (multiplier=1, no growth)
    expect(computeBackoff(0, config, () => 0)).toBeCloseTo(500);
    expect(computeBackoff(0, config, () => 1)).toBeCloseTo(1_500);
  });
});
