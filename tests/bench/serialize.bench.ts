import { bench, describe } from "vitest";
import { serializeInteractionInputMessage } from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ─── Fixtures — allocated once, outside the measured hot loop ─────────────────
//
// Using a fixed timestamp avoids measuring Date.now() variance.
// Each payload is pre-allocated so the bench measures only serialization cost
// (header writes + Uint8Array.set), not GC pressure from fixture allocation.

const FIXED_TS = 1_700_000_000;

/** ~1 KB text payload (ASCII fill). */
const TEXT_1KB = new Uint8Array(1_024).fill(0x61); // 'a'

/** ~100 KB audio payload. */
const AUDIO_100KB = new Uint8Array(100 * 1_024).fill(0x42);

/** ~500 KB audio payload. */
const AUDIO_500KB = new Uint8Array(500 * 1_024).fill(0x42);

// ─── Benchmarks ───────────────────────────────────────────────────────────────

describe("serializeInteractionInputMessage", () => {
  bench("serialize 1 KB text", () => {
    serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "text",
        payload: TEXT_1KB,
        timestamp: FIXED_TS,
        params: null,
      },
    });
  });

  bench("serialize 100 KB audio", () => {
    serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: AUDIO_100KB,
        timestamp: FIXED_TS,
        params: null,
      },
    });
  });

  bench("serialize 500 KB audio", () => {
    serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: AUDIO_500KB,
        timestamp: FIXED_TS,
        params: null,
      },
    });
  });
});
