/**
 * Tests for the OjinClient convenience sender methods (ost-s8z9):
 *   sendText, sendAudio, interrupt, endInteraction.
 *
 * These methods are ergonomic wrappers over `sendMessage` that construct the
 * appropriate message objects.  The tests verify:
 *  - Each method delegates to `sendMessage` with the correct message instance.
 *  - The logical payload produced (via `.toMessage()`) is structurally equal to
 *    what constructing the message directly would produce, **excluding the
 *    `timestamp` field** which is set to `Date.now()` at construction time.
 *  - Optional `params` are forwarded without modification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinClient,
  OjinEndInteractionMessage,
  OjinTextInputMessage,
} from "../../src/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Recursively remove every `timestamp` key from a plain-object tree so that
 * structural equality assertions are not broken by `Date.now()` drift between
 * two message constructions.
 */
function omitTimestamp(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitTimestamp);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "timestamp") continue;
      result[k] = omitTimestamp(v);
    }
    return result;
  }
  return value;
}

// ── Fixture ────────────────────────────────────────────────────────────────────

describe("OjinClient convenience senders", () => {
  let client: OjinClient;

  beforeEach(() => {
    client = new OjinClient({
      wsUrl: "ws://127.0.0.1:1", // unreachable — sendMessage is mocked
      apiKey: "test-key",
      configId: "test-config",
    });

    // Intercept sendMessage so no real transport is needed.
    vi.spyOn(client, "sendMessage").mockResolvedValue(undefined);
  });

  // ── sendText ─────────────────────────────────────────────────────────────────

  describe("sendText", () => {
    it("delegates to sendMessage with an OjinTextInputMessage", async () => {
      await client.sendText("hello");

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const arg = vi.mocked(client.sendMessage).mock.calls[0][0];
      expect(arg).toBeInstanceOf(OjinTextInputMessage);
    });

    it("produces a payload structurally equal (excl. timestamp) to the direct constructor", async () => {
      await client.sendText("hello");

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinTextInputMessage;
      const direct = new OjinTextInputMessage("hello");

      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });

    it("forwards optional params", async () => {
      const params = { language: "en", speed: 1.2 };
      await client.sendText("hi", params);

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinTextInputMessage;
      expect(arg.params).toEqual(params);
    });

    it("omits params when not provided", async () => {
      await client.sendText("hi");

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinTextInputMessage;
      // params should be undefined (not set)
      expect(arg.params).toBeUndefined();
    });

    it("returns the same promise as sendMessage", async () => {
      const result = client.sendText("hi");
      await expect(result).resolves.toBeUndefined();
    });
  });

  // ── sendAudio ─────────────────────────────────────────────────────────────────

  describe("sendAudio", () => {
    it("delegates to sendMessage with an OjinAudioInputMessage", async () => {
      const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      await client.sendAudio(pcm);

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const arg = vi.mocked(client.sendMessage).mock.calls[0][0];
      expect(arg).toBeInstanceOf(OjinAudioInputMessage);
    });

    it("produces a payload structurally equal (excl. timestamp) to the direct constructor", async () => {
      const pcm = new Uint8Array([0x10, 0x20]);
      await client.sendAudio(pcm);

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinAudioInputMessage;
      const direct = new OjinAudioInputMessage(pcm as Uint8Array<ArrayBuffer>);

      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });

    it("forwards params through unmodified", async () => {
      const pcm = new Uint8Array([0xab, 0xcd]);
      const params = { voiceId: "en_1" };
      await client.sendAudio(pcm, params);

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinAudioInputMessage;
      expect(arg.params).toEqual(params);
      // Structural equality with direct construction using same params
      const direct = new OjinAudioInputMessage(pcm as Uint8Array<ArrayBuffer>, params);
      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });
  });

  // ── interrupt ─────────────────────────────────────────────────────────────────

  describe("interrupt", () => {
    it("delegates to sendMessage with an OjinCancelInteractionMessage", async () => {
      await client.interrupt();

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const arg = vi.mocked(client.sendMessage).mock.calls[0][0];
      expect(arg).toBeInstanceOf(OjinCancelInteractionMessage);
    });

    it("produces a payload structurally equal (excl. timestamp) to the direct constructor", async () => {
      await client.interrupt();

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinCancelInteractionMessage;
      const direct = new OjinCancelInteractionMessage();

      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });

    it("returns Promise<void>", async () => {
      await expect(client.interrupt()).resolves.toBeUndefined();
    });
  });

  // ── endInteraction ────────────────────────────────────────────────────────────

  describe("endInteraction", () => {
    it("delegates to sendMessage with an OjinEndInteractionMessage", async () => {
      await client.endInteraction();

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const arg = vi.mocked(client.sendMessage).mock.calls[0][0];
      expect(arg).toBeInstanceOf(OjinEndInteractionMessage);
    });

    it("produces a payload structurally equal (excl. timestamp) to the direct constructor", async () => {
      await client.endInteraction();

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinEndInteractionMessage;
      const direct = new OjinEndInteractionMessage();

      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });

    it("returns Promise<void>", async () => {
      await expect(client.endInteraction()).resolves.toBeUndefined();
    });
  });

  // ── Cross-method: raw sendMessage still public ─────────────────────────────────

  describe("raw sendMessage remains public", () => {
    it("sendMessage can be called directly with any OjinClientMessage subclass", async () => {
      // Verify that the convenience methods don't shadow the raw API.
      const msg = new OjinTextInputMessage("direct");
      await client.sendMessage(msg);

      expect(client.sendMessage).toHaveBeenCalledWith(msg);
    });
  });
});
