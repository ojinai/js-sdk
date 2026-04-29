import { describe, expect, it } from "vitest";
import {
  deserializeInteractionInputMessage,
  deserializeInteractionResponseMessage,
  PayloadType,
  payloadTypeFromStr,
  payloadTypeToStr,
  serializeInteractionInputMessage,
  serializeInteractionResponseMessage,
} from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";
import { bytesToUuid, NIL_UUID, uuidToBytes } from "../../src/utils/uuid.js";

describe("UUID helpers", () => {
  it("should round-trip a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const bytes = uuidToBytes(uuid);
    expect(bytes.length).toBe(16);
    expect(bytesToUuid(bytes)).toBe(uuid);
  });

  it("should handle NIL_UUID", () => {
    expect(NIL_UUID).toBe("00000000-0000-0000-0000-000000000000");
    const bytes = uuidToBytes(NIL_UUID);
    expect(bytes.length).toBe(16);
    expect(bytesToUuid(bytes)).toBe(NIL_UUID);
  });
});

describe("InteractionInputMessage serialization", () => {
  it("should round-trip a text input without params", () => {
    const msg = {
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "text",
        payload: new TextEncoder().encode("Hello, world!"),
        timestamp: 123456789,
        params: null,
      },
    };

    const bytes = serializeInteractionInputMessage(msg);
    const deserialized = deserializeInteractionInputMessage(bytes);

    expect(deserialized.type).toBe(MessageType.InteractionInput);
    expect(deserialized.payload.payloadType).toBe("text");
    expect(new TextDecoder().decode(deserialized.payload.payload)).toBe("Hello, world!");
    expect(deserialized.payload.timestamp).toBe(123456789);
    expect(deserialized.payload.params).toBeNull();
  });

  it("should round-trip an audio input with params", () => {
    const audioData = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const msg = {
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: audioData,
        timestamp: 999888777,
        params: { sampleRate: 16000, language: "en" },
      },
    };

    const bytes = serializeInteractionInputMessage(msg);
    const deserialized = deserializeInteractionInputMessage(bytes);

    expect(deserialized.payload.payloadType).toBe("audio");
    expect(deserialized.payload.payload).toEqual(audioData);
    expect(deserialized.payload.timestamp).toBe(999888777);
    expect(deserialized.payload.params).toEqual({ sampleRate: 16000, language: "en" });
  });

  it("should round-trip an empty payload", () => {
    const msg = {
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: new Uint8Array(0),
        timestamp: 100,
        params: null,
      },
    };

    const bytes = serializeInteractionInputMessage(msg);
    const deserialized = deserializeInteractionInputMessage(bytes);
    expect(deserialized.payload.payload.length).toBe(0);
  });
});

describe("InteractionResponseMessage serialization", () => {
  it("should round-trip a response with multiple payloads", () => {
    const msg = {
      type: MessageType.InteractionResponse,
      payload: {
        interactionId: "550e8400-e29b-41d4-a716-446655440000",
        payloads: [
          { payloadType: "image", data: new Uint8Array([10, 20, 30]) },
          { payloadType: "audio", data: new Uint8Array([40, 50, 60, 70]) },
        ],
        isFinalResponse: false,
        timestamp: 123456,
        usage: 42,
        index: 7,
      },
    };

    const bytes = serializeInteractionResponseMessage(msg);
    const deserialized = deserializeInteractionResponseMessage(bytes);

    expect(deserialized.type).toBe(MessageType.InteractionResponse);
    expect(deserialized.payload.interactionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(deserialized.payload.payloads.length).toBe(2);
    expect(deserialized.payload.payloads[0].payloadType).toBe("image");
    expect(deserialized.payload.payloads[0].data).toEqual(new Uint8Array([10, 20, 30]));
    expect(deserialized.payload.payloads[1].payloadType).toBe("audio");
    expect(deserialized.payload.isFinalResponse).toBe(false);
    expect(deserialized.payload.timestamp).toBe(123456);
    expect(deserialized.payload.usage).toBe(42);
    expect(deserialized.payload.index).toBe(7);
    expect(Array.from(bytes.slice(37, 42))).toEqual([0x00, 0x00, 0x00, 0x03, PayloadType.Image]);
  });

  it("should round-trip a final response with nil UUID", () => {
    const msg = {
      type: MessageType.InteractionResponse,
      payload: {
        interactionId: NIL_UUID,
        payloads: [{ payloadType: "image", data: new Uint8Array([1, 2]) }],
        isFinalResponse: true,
        timestamp: 999,
        usage: 1,
        index: 0,
      },
    };

    const bytes = serializeInteractionResponseMessage(msg);
    const deserialized = deserializeInteractionResponseMessage(bytes);

    expect(deserialized.payload.interactionId).toBe(NIL_UUID);
    expect(deserialized.payload.isFinalResponse).toBe(true);
  });

  it("should throw on truncated data", () => {
    expect(() => deserializeInteractionResponseMessage(new Uint8Array(10))).toThrow(
      "message too short",
    );
    expect(() => deserializeInteractionInputMessage(new Uint8Array(5))).toThrow(
      "message too short",
    );
  });
});

describe("PayloadType conversions", () => {
  it("should convert string to enum and back", () => {
    expect(payloadTypeFromStr("text")).toBe(PayloadType.Text);
    expect(payloadTypeFromStr("audio")).toBe(PayloadType.Audio);
    expect(payloadTypeFromStr("image")).toBe(PayloadType.Image);
    expect(payloadTypeFromStr("video")).toBe(PayloadType.Video);
    expect(payloadTypeFromStr("unknown")).toBe(PayloadType.Text); // fallback

    expect(payloadTypeToStr(PayloadType.Text)).toBe("text");
    expect(payloadTypeToStr(PayloadType.Audio)).toBe("audio");
    expect(payloadTypeToStr(PayloadType.Image)).toBe("image");
    expect(payloadTypeToStr(PayloadType.Video)).toBe("video");
  });
});
