import type { ReconnectBackoff } from "../types.js";

/**
 * Default values for `ReconnectBackoff`, applied when the caller omits
 * `reconnectBackoff` entirely from `OjinClientOptions`.
 *
 * These are also the values assumed by `computeBackoff` documentation examples.
 */
export const DEFAULT_RECONNECT_BACKOFF: Required<ReconnectBackoff> = {
  initialMs: 500,
  maxMs: 30_000,
  multiplier: 2,
  jitter: 0.3,
};

/**
 * Computes a jittered exponential backoff delay for live-drop reconnection.
 *
 * Formula:
 * ```
 * nominal = min(initialMs × multiplier^attempt, maxMs)
 * delay   = nominal × (1 − jitter + 2 × jitter × random())
 *         = nominal × uniform([1 − jitter, 1 + jitter])
 * ```
 *
 * Keeping the formula in one place makes it unit-testable with a seeded PRNG
 * and prevents the reconnect loop from inlining ad-hoc math.
 *
 * @param attempt - Zero-based retry index (0 = first retry after the drop).
 * @param config  - Fully-specified backoff configuration (all fields required).
 * @param random  - PRNG returning values in `[0, 1)`. Defaults to
 *                  `Math.random`. Pass a seeded function for deterministic
 *                  tests or statistical verification.
 * @returns Backoff delay in milliseconds.
 */
export function computeBackoff(
  attempt: number,
  config: Required<ReconnectBackoff>,
  random: () => number = Math.random,
): number {
  const { initialMs, maxMs, multiplier, jitter } = config;
  const nominal = Math.min(initialMs * multiplier ** attempt, maxMs);
  // jitter factor is uniformly distributed in [1 − jitter, 1 + jitter]
  const factor = 1 - jitter + 2 * jitter * random();
  return nominal * factor;
}
