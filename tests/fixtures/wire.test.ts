/**
 * Wire-compatibility test suite.
 *
 * Reads every fixture in tests/fixtures/wire/ and asserts that the TypeScript
 * SDK produces byte-identical output for client-originated messages, and that
 * the deserializers produce the expected logical shape for server-originated
 * messages.
 *
 * Run standalone:
 *   pnpm test:wire-compat
 *
 * A failure message identifies the specific fixture that diverged and prints a
 * byte-level diff of the first 64 differing bytes so the exact field offset is
 * immediately visible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OjinCancelInteractionMessage,
  OjinEndInteractionMessage,
} from "../../src/protocol/client-messages.js";
import {
  deserializeInteractionInputMessage,
  deserializeInteractionResponseMessage,
  serializeInteractionInputMessage,
  serializeInteractionResponseMessage,
} from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dirname, "wire");

function readBin(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

function readMeta(name: string): FixtureMeta {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as FixtureMeta;
}

interface FixtureMeta {
  fixtureName: string;
  pythonSdkVersion: string;
  messageShape: string;
  direction: "client-to-server" | "server-to-client";
  encoding: "binary" | "json-utf8";
  fields: Record<string, unknown>;
  expectedRoundTrip: Record<string, unknown>;
}

/**
 * Produce a human-readable byte-diff message for the first 64 bytes around the
 * first divergence.  Used in test failure messages to immediately show which
 * field shifted.
 */
function byteDiffMessage(fixtureName: string, actual: Uint8Array, expected: Uint8Array): string {
  const minLen = Math.min(actual.length, expected.length);
  for (let i = 0; i < minLen; i++) {
    if (actual[i] !== expected[i]) {
      const windowStart = Math.max(0, i - 4);
      const windowEnd = Math.min(minLen, i + 60);
      const toHex = (arr: Uint8Array) =>
        Array.from(arr.subarray(windowStart, windowEnd))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
      return (
        `[wire-compat] fixture "${fixtureName}" diverges at byte offset ${i}.\n` +
        `  Expected (Python): ${toHex(expected)}\n` +
        `  Got      (TS SDK): ${toHex(actual)}\n` +
        `  Expected length: ${expected.length}, Got length: ${actual.length}`
      );
    }
  }
  if (actual.length !== expected.length) {
    return (
      `[wire-compat] fixture "${fixtureName}" length mismatch: ` +
      `expected ${expected.length} bytes, got ${actual.length} bytes`
    );
  }
  return "identical";
}

/**
 * Assert byte equality and produce a rich diagnostic on failure.
 */
function assertBytesMatch(fixtureName: string, actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length === expected.length && actual.every((b, i) => b === expected[i])) return;
  throw new Error(byteDiffMessage(fixtureName, actual, expected));
}

// Fixed timestamp used in every fixture (matches the generation script).
const FIXTURE_TIMESTAMP_MS = 1_000_000_000;

// ─── Client-originated binary fixtures ───────────────────────────────────────

describe("wire-compat: client → server binary messages", () => {
  it("text_input — plain ASCII text, no params", () => {
    const meta = readMeta("text_input.json");
    const fixture = readBin("text_input.bin");

    const tsBytes = serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "text",
        payload: new TextEncoder().encode(meta.fields.text as string),
        timestamp: FIXTURE_TIMESTAMP_MS,
        params: null,
      },
    });

    assertBytesMatch(meta.fixtureName, tsBytes, fixture);
    expect(tsBytes).toEqual(fixture);
  });

  it("text_input_unicode — non-ASCII (Japanese) text with params: UTF-8 round-trip preserved", () => {
    const meta = readMeta("text_input_unicode.json");
    const fixture = readBin("text_input_unicode.bin");

    const tsBytes = serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "text",
        payload: new TextEncoder().encode(meta.fields.text as string),
        timestamp: FIXTURE_TIMESTAMP_MS,
        params: meta.fields.params as Record<string, unknown>,
      },
    });

    assertBytesMatch(meta.fixtureName, tsBytes, fixture);
    expect(tsBytes).toEqual(fixture);

    // Also verify round-trip fidelity via deserializer.
    const deserialized = deserializeInteractionInputMessage(fixture);
    expect(new TextDecoder().decode(deserialized.payload.payload)).toBe(meta.fields.text);
    expect(deserialized.payload.params).toEqual(meta.fields.params);
  });

  it("audio_input — raw PCM bytes, no params", () => {
    const meta = readMeta("audio_input.json");
    const fixture = readBin("audio_input.bin");

    const tsBytes = serializeInteractionInputMessage({
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: new Uint8Array(meta.fields.audioBytes as number[]),
        timestamp: FIXTURE_TIMESTAMP_MS,
        params: null,
      },
    });

    assertBytesMatch(meta.fixtureName, tsBytes, fixture);
    expect(tsBytes).toEqual(fixture);
  });
});

// ─── Client-originated JSON fixtures ─────────────────────────────────────────
//
// JSON messages embed a timestamp that would normally be Date.now().  We
// compare the structural fields only (ignoring the timestamp), since the
// Python and TS SDKs both supply the current wall-clock time independently.

describe("wire-compat: client → server JSON messages", () => {
  it("cancel_interaction — JSON structure matches Python SDK wire format", () => {
    const meta = readMeta("cancel_interaction.json");
    const fixture = readBin("cancel_interaction.bin");

    const parsed = JSON.parse(new TextDecoder().decode(fixture)) as Record<string, unknown>;
    expect(parsed.type).toBe(meta.expectedRoundTrip.type);
    expect((parsed.payload as Record<string, unknown>).timestamp).toBeTypeOf("number");

    // Confirm the TS SDK emits the same top-level type key.
    const tsJson = JSON.parse(new OjinCancelInteractionMessage().toBytes() as string) as Record<
      string,
      unknown
    >;
    expect(tsJson.type).toBe(parsed.type);
    expect((tsJson.payload as Record<string, unknown>).timestamp).toBeTypeOf("number");
  });

  it("end_interaction — JSON structure matches Python SDK wire format", () => {
    const meta = readMeta("end_interaction.json");
    const fixture = readBin("end_interaction.bin");

    const parsed = JSON.parse(new TextDecoder().decode(fixture)) as Record<string, unknown>;
    expect(parsed.type).toBe(meta.expectedRoundTrip.type);
    expect((parsed.payload as Record<string, unknown>).timestamp).toBeTypeOf("number");

    const tsJson = JSON.parse(new OjinEndInteractionMessage().toBytes() as string) as Record<
      string,
      unknown
    >;
    expect(tsJson.type).toBe(parsed.type);
    expect((tsJson.payload as Record<string, unknown>).timestamp).toBeTypeOf("number");
  });
});

// ─── Server-originated binary fixtures ───────────────────────────────────────

describe("wire-compat: server → client binary messages", () => {
  it("interaction_response_jpeg — deserializes to expected logical shape", () => {
    const meta = readMeta("interaction_response_jpeg.json");
    const fixture = readBin("interaction_response_jpeg.bin");

    const msg = deserializeInteractionResponseMessage(fixture);

    expect(msg.type).toBe(MessageType.InteractionResponse);
    expect(msg.payload.interactionId).toBe(meta.fields.interactionId);
    expect(msg.payload.isFinalResponse).toBe(meta.fields.isFinalResponse);
    expect(msg.payload.usage).toBe(meta.fields.usage);
    expect(msg.payload.index).toBe(meta.fields.index);
    expect(msg.payload.timestamp).toBe(FIXTURE_TIMESTAMP_MS);
    expect(msg.payload.payloads).toHaveLength(1);
    expect(msg.payload.payloads[0].payloadType).toBe("image");

    const expectedData = new Uint8Array(
      (meta.fields.payloads as Array<{ dataBytes: number[] }>)[0].dataBytes,
    );
    expect(msg.payload.payloads[0].data).toEqual(expectedData);
  });

  it("interaction_response_audio — deserializes idle (nil-UUID) frame to expected logical shape", () => {
    const meta = readMeta("interaction_response_audio.json");
    const fixture = readBin("interaction_response_audio.bin");

    const msg = deserializeInteractionResponseMessage(fixture);

    expect(msg.type).toBe(MessageType.InteractionResponse);
    expect(msg.payload.interactionId).toBe(meta.fields.interactionId); // nil UUID
    expect(msg.payload.isFinalResponse).toBe(meta.fields.isFinalResponse);
    expect(msg.payload.usage).toBe(meta.fields.usage);
    expect(msg.payload.index).toBe(meta.fields.index);
    expect(msg.payload.timestamp).toBe(FIXTURE_TIMESTAMP_MS);
    expect(msg.payload.payloads).toHaveLength(1);
    expect(msg.payload.payloads[0].payloadType).toBe("audio");

    const expectedData = new Uint8Array(
      (meta.fields.payloads as Array<{ dataBytes: number[] }>)[0].dataBytes,
    );
    expect(msg.payload.payloads[0].data).toEqual(expectedData);
  });
});

// ─── Server-originated JSON fixtures ─────────────────────────────────────────

describe("wire-compat: server → client JSON messages", () => {
  it("session_ready — parses to expected logical shape", () => {
    const meta = readMeta("session_ready.json");
    const fixture = readBin("session_ready.bin");

    const parsed = JSON.parse(new TextDecoder().decode(fixture)) as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(parsed.type).toBe(meta.expectedRoundTrip.type);
    expect(parsed.payload.traceId).toBe(meta.expectedRoundTrip.traceId);
    expect(parsed.payload.status).toBe(meta.expectedRoundTrip.status);
    expect(parsed.payload.load).toBe(meta.expectedRoundTrip.load);
    expect(parsed.payload.parameters).toBeNull();
    expect(parsed.payload.numClients).toBe(meta.expectedRoundTrip.numClients);
    expect(parsed.payload.maxCapacity).toBe(meta.expectedRoundTrip.maxCapacity);
  });

  it("error_response — parses to expected logical shape", () => {
    const meta = readMeta("error_response.json");
    const fixture = readBin("error_response.bin");

    const parsed = JSON.parse(new TextDecoder().decode(fixture)) as {
      type: string;
      payload: Record<string, unknown>;
    };

    expect(parsed.type).toBe(meta.expectedRoundTrip.type);
    expect(parsed.payload.code).toBe(meta.expectedRoundTrip.code);
    expect(parsed.payload.message).toBe(meta.expectedRoundTrip.message);
    expect(parsed.payload.interactionId).toBeNull();
    expect(parsed.payload.details).toBeNull();
    expect(parsed.payload.timestamp).toBe(FIXTURE_TIMESTAMP_MS);
  });
});

// ─── Regression guard: header-size constant ───────────────────────────────────
//
// This test will fail if INTERACTION_INPUT_HEADER_SIZE is changed from 13,
// because the serialized text_input.bin will produce wrong byte offsets.
// The failure message from assertBytesMatch will show the exact byte that
// diverges and what shifted.

describe("wire-compat: protocol header invariants", () => {
  it("InteractionInput header is exactly 13 bytes (offset 13 must start payload)", () => {
    const fixture = readBin("text_input.bin");
    // Byte 12 is the last paramsSize byte; byte 13 is the first payload byte.
    // For text_input "Hello, Ojin!" (ASCII), byte 13 must be 0x48 ('H').
    expect(fixture[13]).toBe(0x48); // 'H'
    expect(fixture[14]).toBe(0x65); // 'e'
    expect(fixture[15]).toBe(0x6c); // 'l'
  });

  it("InteractionResponse header is exactly 37 bytes (offset 37 must start first payload entry)", () => {
    const fixture = readBin("interaction_response_jpeg.bin");
    // Bytes 37-40 are the dataSize LE of the first payload.
    // The JPEG fixture has 12 bytes of JPEG data, so dataSize = 12 = 0x0C.
    expect(fixture[37]).toBe(0x0c); // 12 LE low byte
    expect(fixture[38]).toBe(0x00);
    expect(fixture[39]).toBe(0x00);
    expect(fixture[40]).toBe(0x00);
    // Byte 41 is payloadType = Image = 2.
    expect(fixture[41]).toBe(0x02);
  });

  it("InteractionInput round-trips back to the fixture bytes", () => {
    const meta = readMeta("text_input.json");
    const fixture = readBin("text_input.bin");

    const deserialized = deserializeInteractionInputMessage(fixture);
    const re_serialized = serializeInteractionInputMessage(deserialized);

    assertBytesMatch(`${meta.fixtureName} (round-trip)`, re_serialized, fixture);
    expect(re_serialized).toEqual(fixture);
  });

  it("InteractionResponse round-trips back to the fixture bytes", () => {
    const meta = readMeta("interaction_response_jpeg.json");
    const fixture = readBin("interaction_response_jpeg.bin");

    const deserialized = deserializeInteractionResponseMessage(fixture);
    const reSerialized = serializeInteractionResponseMessage(deserialized);

    assertBytesMatch(`${meta.fixtureName} (round-trip)`, reSerialized, fixture);
    expect(reSerialized).toEqual(fixture);
  });
});
