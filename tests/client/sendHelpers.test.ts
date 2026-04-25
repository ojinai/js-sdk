/**
 * Tests for the OjinClient convenience sender methods (ost-s8z9):
 *   sendText, sendTextTurn, sendTextTurnAndWait, streamTextTurn,
 *   sendAudio, interrupt, endInteraction.
 *
 * These methods are ergonomic wrappers over `sendMessage` that construct the
 * appropriate message objects.  The tests verify:
 *  - Each method delegates to `sendMessage` with the correct message instance.
 *  - The logical payload produced (via `.toMessage()`) is structurally equal to
 *    what constructing the message directly would produce, **excluding the
 *    `timestamp` field** which is set to `Date.now()` at construction time.
 *  - Optional `params` are forwarded without modification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionError,
  DisconnectReason,
  FrameType,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinClient,
  OjinEndInteractionMessage,
  OjinErrorCode,
  OjinEvent,
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
} from "../../src/index.js";
import { NIL_UUID } from "../../src/utils/uuid.js";

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

  afterEach(() => {
    vi.useRealTimers();
  });

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

  // ── sendTextTurn ─────────────────────────────────────────────────────────────

  describe("sendTextTurn", () => {
    it("sends a text message followed by endInteraction", async () => {
      await client.sendTextTurn("hello");

      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      const [textArg, endArg] = vi.mocked(client.sendMessage).mock.calls.map((call) => call[0]);
      expect(textArg).toBeInstanceOf(OjinTextInputMessage);
      expect(endArg).toBeInstanceOf(OjinEndInteractionMessage);
    });

    it("forwards params through the text message", async () => {
      const params = { language: "en", speed: 1.2 };
      await client.sendTextTurn("hello", params);

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinTextInputMessage;
      expect(arg.params).toEqual(params);
    });

    it("stops before endInteraction if sending the text message fails", async () => {
      const failure = new Error("boom");
      vi.mocked(client.sendMessage).mockRejectedValueOnce(failure);

      await expect(client.sendTextTurn("hi")).rejects.toThrow("boom");
      expect(client.sendMessage).toHaveBeenCalledOnce();
      expect(vi.mocked(client.sendMessage).mock.calls[0][0]).toBeInstanceOf(OjinTextInputMessage);
    });

    it("returns Promise<void> for the full text turn", async () => {
      await expect(client.sendTextTurn("hi")).resolves.toBeUndefined();
    });
  });

  describe("sendTextTurnAndWait", () => {
    it("waits for the final speech frame of the same interaction", async () => {
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const result = client.sendTextTurnAndWait(
        "hello",
        { language: "en" },
        { readyTimeoutMs: 45_000, responseTimeoutMs: 2_000 },
      );
      await Promise.resolve();

      const idle = new OjinInteractionResponseMessage(
        NIL_UUID,
        new Uint8Array(0),
        new Uint8Array(0),
        false,
        0,
        FrameType.Idle,
      );
      const partial = new OjinInteractionResponseMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        new Uint8Array(0),
        new Uint8Array([1, 2]),
        false,
        1,
      );
      const final = new OjinInteractionResponseMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        new Uint8Array(0),
        new Uint8Array([3, 4]),
        true,
        2,
      );

      client.events.emit(OjinEvent.InteractionResponse, idle);
      client.events.emit(OjinEvent.InteractionResponse, partial);
      client.events.emit(OjinEvent.InteractionResponse, final);

      await expect(result).resolves.toBe(final);
      expect(client.waitForReady).toHaveBeenCalledWith(45_000);
      expect(client.sendTextTurn).toHaveBeenCalledWith("hello", { language: "en" });
    });

    it("rejects overlapping waiters on the same client", async () => {
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const first = client.sendTextTurnAndWait("first");
      await Promise.resolve();

      await expect(client.sendTextTurnAndWait("second")).rejects.toThrow(
        "High-level text turn helpers do not support concurrent calls on the same client.",
      );

      client.events.emit(
        OjinEvent.InteractionResponse,
        new OjinInteractionResponseMessage(
          "550e8400-e29b-41d4-a716-446655440000",
          new Uint8Array(0),
          new Uint8Array([1]),
          true,
          0,
        ),
      );

      await expect(first).resolves.toBeInstanceOf(OjinInteractionResponseMessage);
    });

    it("rejects with TimeoutError when no final speech frame arrives", async () => {
      vi.useFakeTimers();
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const result = client.sendTextTurnAndWait("hello", undefined, { responseTimeoutMs: 1_000 });
      const assertion = expect(result).rejects.toMatchObject({
        code: OjinErrorCode.Timeout,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await assertion;
    });

    it("rejects when the connection closes before the final frame arrives", async () => {
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const result = client.sendTextTurnAndWait("hello");
      await Promise.resolve();

      client.events.emit(OjinEvent.ConnectionClosed, {
        code: 1006,
        reason: "socket lost",
        disconnectReason: DisconnectReason.ConnectionLost,
      });

      await result.catch((error) => {
        expect(error).toBeInstanceOf(ConnectionError);
        expect(error).toMatchObject({ code: OjinErrorCode.NotConnected });
      });
    });
  });

  describe("streamTextTurn", () => {
    it("yields speech frames for the turn and completes after the final frame", async () => {
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const stream = client.streamTextTurn(
        "hello",
        { language: "en" },
        { readyTimeoutMs: 45_000, responseTimeoutMs: 2_000 },
      );

      const first = stream.next();
      await Promise.resolve();

      client.events.emit(
        OjinEvent.InteractionResponse,
        new OjinInteractionResponseMessage(
          NIL_UUID,
          new Uint8Array(0),
          new Uint8Array(0),
          false,
          0,
          FrameType.Idle,
        ),
      );

      const partial = new OjinInteractionResponseMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        new Uint8Array(0),
        new Uint8Array([1, 2]),
        false,
        1,
      );
      client.events.emit(OjinEvent.InteractionResponse, partial);
      await expect(first).resolves.toEqual({ value: partial, done: false });

      const second = stream.next();
      const final = new OjinInteractionResponseMessage(
        "550e8400-e29b-41d4-a716-446655440000",
        new Uint8Array(0),
        new Uint8Array([3, 4]),
        true,
        2,
      );
      client.events.emit(OjinEvent.InteractionResponse, final);

      await expect(second).resolves.toEqual({ value: final, done: false });
      await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
      expect(client.waitForReady).toHaveBeenCalledWith(45_000);
      expect(client.sendTextTurn).toHaveBeenCalledWith("hello", { language: "en" });
    });

    it("rejects overlapping helpers on the same client", async () => {
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const stream = client.streamTextTurn("first");
      const first = stream.next();
      await Promise.resolve();

      await expect(client.sendTextTurnAndWait("second")).rejects.toThrow(
        "High-level text turn helpers do not support concurrent calls on the same client.",
      );

      client.events.emit(
        OjinEvent.InteractionResponse,
        new OjinInteractionResponseMessage(
          "550e8400-e29b-41d4-a716-446655440000",
          new Uint8Array(0),
          new Uint8Array([1]),
          true,
          0,
        ),
      );

      await expect(first).resolves.toEqual({
        value: expect.any(OjinInteractionResponseMessage),
        done: false,
      });
      await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
    });

    it("rejects when no speech frame arrives before the timeout", async () => {
      vi.useFakeTimers();
      vi.spyOn(client, "waitForReady").mockResolvedValue(new OjinSessionReadyMessage({}));
      vi.spyOn(client, "sendTextTurn").mockResolvedValue(undefined);

      const stream = client.streamTextTurn("hello", undefined, { responseTimeoutMs: 1_000 });
      const next = stream.next();
      const assertion = expect(next).rejects.toMatchObject({ code: OjinErrorCode.Timeout });

      await vi.advanceTimersByTimeAsync(1_000);

      await assertion;
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
      const direct = new OjinAudioInputMessage(pcm);

      expect(omitTimestamp(arg.toMessage())).toEqual(omitTimestamp(direct.toMessage()));
    });

    it("forwards params through unmodified", async () => {
      const pcm = new Uint8Array([0xab, 0xcd]);
      const params = { voiceId: "en_1" };
      await client.sendAudio(pcm, params);

      const arg = vi.mocked(client.sendMessage).mock.calls[0][0] as OjinAudioInputMessage;
      expect(arg.params).toEqual(params);
      // Structural equality with direct construction using same params
      const direct = new OjinAudioInputMessage(pcm, params);
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
