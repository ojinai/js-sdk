import { describe, expect, it } from "vitest";
import {
  FrameType,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinEndInteractionMessage,
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
} from "../../src/protocol/client-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";
import { NIL_UUID } from "../../src/utils/uuid.js";

describe("OjinSessionReadyMessage", () => {
  it("should store parameters", () => {
    const msg = new OjinSessionReadyMessage({ model: "v1" });
    expect(msg.parameters).toEqual({ model: "v1" });
  });

  it("should allow null parameters", () => {
    const msg = new OjinSessionReadyMessage(null);
    expect(msg.parameters).toBeNull();
  });
});

describe("OjinInteractionResponseMessage", () => {
  it("should create from proxy message with idle frame type", () => {
    const proxyMsg = {
      type: MessageType.InteractionResponse,
      payload: {
        interactionId: NIL_UUID,
        payloads: [
          { payloadType: "image", data: new Uint8Array([1, 2, 3]) },
          { payloadType: "audio", data: new Uint8Array([4, 5, 6]) },
        ],
        isFinalResponse: true,
        timestamp: 100,
        usage: 1,
        index: 0,
      },
    };

    const msg = OjinInteractionResponseMessage.fromProxyMessage(proxyMsg);

    expect(msg.interactionId).toBe(NIL_UUID);
    expect(msg.frameType).toBe(FrameType.Idle);
    expect(msg.isFinalResponse).toBe(true);
    expect(msg.videoFrameBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(msg.audioFrameBytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("should create from proxy message with speech frame type", () => {
    const proxyMsg = {
      type: MessageType.InteractionResponse,
      payload: {
        interactionId: "550e8400-e29b-41d4-a716-446655440000",
        payloads: [{ payloadType: "image", data: new Uint8Array([10]) }],
        isFinalResponse: false,
        timestamp: 200,
        usage: 5,
        index: 3,
      },
    };

    const msg = OjinInteractionResponseMessage.fromProxyMessage(proxyMsg);

    expect(msg.frameType).toBe(FrameType.Speech);
    expect(msg.isFinalResponse).toBe(false);
  });
});

describe("OjinCancelInteractionMessage", () => {
  it("should produce a cancel message wrapper", () => {
    const msg = new OjinCancelInteractionMessage();
    const wrapper = msg.toCancelInteractionMessage();

    expect(wrapper.type).toBe(MessageType.CancelInteraction);
    expect(wrapper.payload.timestamp).toBeTypeOf("number");
  });
});

describe("OjinEndInteractionMessage", () => {
  it("should produce an end interaction message", () => {
    const msg = new OjinEndInteractionMessage();
    const proxy = msg.toProxyMessage();

    expect(proxy.type).toBe(MessageType.EndInteraction);
    expect(proxy.payload.timestamp).toBeTypeOf("number");
  });
});

describe("OjinTextInputMessage", () => {
  it("should serialize to binary format", () => {
    const msg = new OjinTextInputMessage("Hello", { language: "en" });
    const bytes = msg.toBytes();

    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes instanceof Uint8Array).toBe(true);
  });

  it("should produce a proxy message with text payload", () => {
    const msg = new OjinTextInputMessage("Hello");
    const proxy = msg.toProxyMessage();

    expect(proxy.type).toBe(MessageType.InteractionInput);
    expect(proxy.payload.payloadType).toBe("text");
    expect(new TextDecoder().decode(proxy.payload.payload)).toBe("Hello");
  });
});

describe("OjinAudioInputMessage", () => {
  it("should serialize to binary format", () => {
    const audioData = new Uint8Array([0, 1, 2, 3]);
    const msg = new OjinAudioInputMessage(audioData);
    const bytes = msg.toBytes();

    expect(bytes.length).toBeGreaterThan(0);
  });

  it("should produce a proxy message with audio payload", () => {
    const audioData = new Uint8Array([0, 1, 2, 3]);
    const msg = new OjinAudioInputMessage(audioData, { sampleRate: 16000 });
    const proxy = msg.toProxyMessage();

    expect(proxy.type).toBe(MessageType.InteractionInput);
    expect(proxy.payload.payloadType).toBe("audio");
    expect(proxy.payload.payload).toEqual(audioData);
    expect(proxy.payload.params).toEqual({ sampleRate: 16000 });
  });
});
