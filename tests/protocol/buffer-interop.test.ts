/**
 * Node Buffer slice-integrity runtime test.
 *
 * Verifies that OjinAudioInputMessage correctly respects byteOffset and
 * byteLength when the audio payload is a Buffer backed by Node's shared pool,
 * i.e. only the 16 intended bytes reach the wire — not the surrounding pool.
 *
 * This test is Node-only and is skipped in browser environments.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { OjinAudioInputMessage, OjinClient, OjinEvent } from "../../src/index.js";
import { deserializeInteractionInputMessage } from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

// ─── Sentinel constants ───────────────────────────────────────────────────────

/** Written to pool[0..31] — must NOT appear in the wire payload. */
const SENTINEL_A = 0xaa;
/** Written to pool[32..63] — the intended slice bytes that MUST appear on the wire. */
const SENTINEL_B = 0xbb;
/** pool[64..1023] remain 0x00 (Buffer.alloc zero-fills). */

// ─── Pool factory ─────────────────────────────────────────────────────────────

/**
 * Allocate a 1024-byte pool with two distinct sentinel regions.
 *
 * Layout:
 *   [0..31]  — SENTINEL_A (must not reach the wire)
 *   [32..63] — SENTINEL_B (pool[32..47] is the intended 16-byte slice)
 *   [64..1023] — 0x00
 */
function makePool(): Buffer {
  const pool = Buffer.alloc(1024);
  pool.fill(SENTINEL_A, 0, 32);
  pool.fill(SENTINEL_B, 32, 64);
  return pool;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe.skipIf(typeof Buffer === "undefined")("Node Buffer slice-integrity", () => {
  let wss: WebSocketServer;
  let port: number;
  /** Queue of resolvers awaiting the next deserialized audio payload from the server. */
  let payloadResolvers: Array<(payload: Uint8Array) => void>;

  beforeEach(async () => {
    payloadResolvers = [];

    wss = new WebSocketServer({ port: 0 });

    await new Promise<void>((resolve) => {
      wss.on("listening", () => {
        const addr = wss.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });

    wss.on("connection", (ws: WsSocket) => {
      // Send SessionReady so OjinClient transitions to ready and allows sendMessage.
      ws.send(
        JSON.stringify({
          type: MessageType.SessionReady,
          payload: {
            traceId: "buffer-interop-test",
            status: "success",
            load: 0.0,
            timestamp: Date.now(),
            parameters: {},
          },
        }),
      );

      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        try {
          const inputMsg = deserializeInteractionInputMessage(new Uint8Array(data as Buffer));
          // Copy the payload to break any reference to the wire buffer.
          const payload = new Uint8Array(inputMsg.payload.payload);
          const resolver = payloadResolvers.shift();
          if (resolver !== undefined) resolver(payload);
        } catch {
          // Let the test time out with a meaningful error.
        }
      });
    });
  });

  afterEach(async () => {
    for (const ws of wss.clients) ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function createClient(): OjinClient {
    return new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      configId: "test-config-id",
    });
  }

  async function waitForSessionReady(client: OjinClient, timeoutMs = 3000): Promise<void> {
    if (client.isServerReady) return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for session ready")),
        timeoutMs,
      );
      client.events.on(OjinEvent.SessionReady, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /** Register a resolver and return a promise for the next received audio payload. */
  function nextPayload(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve) => {
      payloadResolvers.push(resolve);
    });
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  // ─── AC3 / AC4 / AC5: sendMessage integration ────────────────────────────────

  it("sendMessage(Buffer-pool-slice) transmits exactly the 16 intended bytes — pool backing bytes do not leak", async () => {
    const pool = makePool();
    // slice is a 16-byte view into pool[32..47] backed by the shared pool ArrayBuffer.
    const slice = Buffer.from(pool.buffer, pool.byteOffset + 32, 16);

    const client = createClient();
    await client.connect();
    await waitForSessionReady(client);

    // ── Part 1: send the pool-backed Buffer slice (AC3) ─────────────────────

    const slicePayloadPromise = nextPayload();
    await client.sendMessage(new OjinAudioInputMessage(slice));
    const slicePayload = await withTimeout(slicePayloadPromise, 3000);

    // AC4.1 — exact payload length: only the 16 slice bytes arrive.
    expect(slicePayload.length).toBe(16);

    // AC4.2 — all bytes are SENTINEL_B (pool[32..47]).
    const expectedBytes = new Uint8Array(16).fill(SENTINEL_B);
    expect(slicePayload).toEqual(expectedBytes);

    // AC4.3 — no pool[0..31] bytes (SENTINEL_A) leaked onto the wire.
    expect(Array.from(slicePayload).every((b) => b !== SENTINEL_A)).toBe(true);

    // ── Part 2: positive control — copy into fresh Uint8Array (AC5) ─────────
    //
    // new Uint8Array(slice) copies the values[0..15] from the view into a
    // standalone buffer with no shared backing.  The mock server must see the
    // same 16 bytes, which proves the assertion harness is sensitive: if the
    // harness passed for wrong data, it would also pass for the wrong data
    // here, making the earlier negative assertions meaningless.

    const copiedSlice = new Uint8Array(slice);
    const copyPayloadPromise = nextPayload();
    await client.sendMessage(new OjinAudioInputMessage(copiedSlice));
    const copyPayload = await withTimeout(copyPayloadPromise, 3000);

    // AC5 — copy and slice produce identical wire payloads.
    expect(copyPayload).toEqual(slicePayload);

    await client.close();
  });

  // ─── AC6: toBytes() unit path ─────────────────────────────────────────────

  it("toBytes() serialises only the 16 slice bytes as the audio payload", () => {
    const pool = makePool();
    const slice = Buffer.from(pool.buffer, pool.byteOffset + 32, 16);

    const serialized = new OjinAudioInputMessage(slice).toBytes();

    // Deserialize to isolate the audio payload section.
    const deserialized = deserializeInteractionInputMessage(serialized);

    // Correct payload type.
    expect(deserialized.payload.payloadType).toBe("audio");

    // Exact length — not the full pool or backing ArrayBuffer.
    expect(deserialized.payload.payload.length).toBe(16);

    // All bytes are SENTINEL_B (pool[32..47]).
    const expectedBytes = new Uint8Array(16).fill(SENTINEL_B);
    expect(deserialized.payload.payload).toEqual(expectedBytes);

    // No pool[0..31] bytes (SENTINEL_A) in the serialized payload.
    expect(Array.from(deserialized.payload.payload).every((b) => b !== SENTINEL_A)).toBe(true);
  });
});
