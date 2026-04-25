/**
 * Property-based tests for InteractionInputMessage serialization.
 *
 * Invariant: deserialize(serialize(x)) === x for all valid inputs (excluding
 * the timestamp field, which is stored in a 32-bit slot and therefore lossy for
 * real-world timestamps — the invariant is validated for a fixed timestamp).
 *
 * Covers the three axes called out in PLAN.md §9.3:
 *   payloadType  × params  × payloadSize
 *
 * Shrinking is left at fast-check's default (enabled): when a failure is
 * found, fast-check reports a minimal counterexample in the CI log.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deserializeInteractionInputMessage,
  PayloadType,
  payloadTypeToStr,
  serializeInteractionInputMessage,
} from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * All numeric PayloadType enum values — the only values the serializer accepts.
 * TypeScript numeric enums expose both `{ Name: value }` and `{ value: Name }`
 * pairs in Object.values; the typeof guard keeps only the numbers.
 */
const PAYLOAD_TYPE_VALUES = Object.values(PayloadType).filter(
  (v): v is PayloadType => typeof v === "number",
) as PayloadType[];

/**
 * Build a deterministic ramp payload of `size` bytes (0x00, 0x01, …, 0xff,
 * 0x00, …). Using a non-uniform pattern ensures the comparison catches any
 * byte that is misplaced or corrupted during the copy.
 */
function makePayload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = i & 0xff;
  }
  return bytes;
}

// ─── Property test ────────────────────────────────────────────────────────────

describe("InteractionInputMessage property tests", () => {
  it("deserialize(serialize(x)) structurally equals x (excluding timestamp) for all valid inputs", {
    timeout: 60_000,
  }, () => {
    fc.assert(
      fc.property(
        // payloadType: every valid PayloadType enum value
        fc.constantFrom(...PAYLOAD_TYPE_VALUES),
        // params: an arbitrary dictionary of mixed scalar values, as used by
        // callers to pass extra metadata alongside the payload
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        // payloadSize: bounded to 256 KB — well below the server's hard limit
        // so that fuzz runs stay fast. fast-check biases towards small values,
        // so most iterations exercise the header-only path.
        fc.nat({ max: 256_000 }),
        (payloadType, params, payloadSize) => {
          const payload = makePayload(payloadSize);

          const msg = {
            type: MessageType.InteractionInput as const,
            payload: {
              payloadType: payloadTypeToStr(payloadType),
              payload,
              // Fixed timestamp: the serializer stores only the low 32 bits
              // (real-world Date.now() values overflow that slot). We exclude
              // the timestamp from the invariant per PLAN.md §9.3.
              timestamp: 1_000_000,
              params,
            },
          };

          const bytes = serializeInteractionInputMessage(msg);
          const deserialized = deserializeInteractionInputMessage(bytes);

          // Exclude timestamp from both sides — it is intentionally lossless
          // for values that fit in 32 bits but the invariant is stated without
          // it ("same pattern as ost-s8z9").
          const { timestamp: _ts1, ...expected } = msg.payload;
          const { timestamp: _ts2, ...actual } = deserialized.payload;

          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});
