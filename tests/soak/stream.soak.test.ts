/**
 * Baselines set in v1.0 development; ratified into v1.5 acceptance per PLAN.md §3.2.
 *
 * This soak suite intentionally stays out of the default `pnpm test` path and is
 * driven by `pnpm test:soak` plus a nightly CI job.
 *
 * Notes:
 * - This checkout does not expose `unsafe_createClientWithApiKey`, so the soak
 *   client is created through the public `new OjinClient(...)` API instead.
 * - We use a local WS harness rather than `tests/helpers/mock-server.ts`
 *   because the soak needs sustained 25 fps streaming plus scheduled disconnect
 *   injection under fake timers.
 */

import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWS, WebSocketServer } from "ws";
import { ConnectionState, OjinClient, OjinEvent } from "../../src/index.js";
import { serializeInteractionResponseMessage } from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

const SIMULATED_STREAM_MS = 10 * 60 * 1000;
const WARMUP_MS = 2 * 60 * 1000;
const SAMPLE_EVERY_MS = 30 * 1000;
const ADVANCE_SLICE_MS = 200;
const RESPONSE_EVERY_MS = 40;
const AUDIO_EVERY_MS = 20;
const RESPONSE_TIMEOUT_MS = 11 * 60 * 1000;

const RSS_SLOPE_BUDGET_KB_PER_MIN = 500;
const HEAP_SLOPE_BUDGET_KB_PER_MIN = 200;

const VIDEO_PAYLOAD = new Uint8Array(40 * 1024).fill(0x4a);
const AUDIO_PAYLOAD = new Uint8Array(640).fill(0x15);
const CLIENT_AUDIO_FRAME = new Uint8Array(640).fill(0x22);

const STREAM_RESPONSE_FRAME = Buffer.from(
  serializeInteractionResponseMessage({
    type: MessageType.InteractionResponse,
    payload: {
      interactionId: "550e8400-e29b-41d4-a716-446655440000",
      payloads: [
        { payloadType: "image", data: VIDEO_PAYLOAD },
        { payloadType: "audio", data: AUDIO_PAYLOAD },
      ],
      isFinalResponse: false,
      timestamp: Date.now(),
      index: 0,
      usage: 1,
    },
  }),
);

type ProcessWithInternals = NodeJS.Process & {
  _getActiveHandles?: () => unknown[];
};

type MemorySample = {
  elapsedMs: number;
  heapUsed: number;
  rss: number;
};

type GlobalWithGc = typeof globalThis & {
  gc?: () => void;
};

function sessionReadyFrame(): string {
  return JSON.stringify({
    type: MessageType.SessionReady,
    payload: {
      traceId: "soak-trace",
      status: "success",
      load: 0.5,
      timestamp: Date.now(),
      parameters: { profile: "soak" },
    },
  });
}

function activeHandleCount(): number {
  return ((process as ProcessWithInternals)._getActiveHandles?.() ?? []).length;
}

function slopeKbPerMinute(samples: MemorySample[], key: "rss" | "heapUsed"): number {
  const steadyState = samples.filter((sample) => sample.elapsedMs >= WARMUP_MS);
  if (steadyState.length < 2) {
    throw new Error("not enough steady-state samples to compute a slope");
  }

  const points = steadyState.map((sample) => ({
    x: (sample.elapsedMs - WARMUP_MS) / 60_000,
    y: sample[key] / 1024,
  }));

  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    numerator += dx * (point.y - meanY);
    denominator += dx * dx;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

async function flushEventLoop(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index++) {
    await setImmediatePromise();
  }
}

async function waitUntil(condition: () => boolean, maxTurns = 4_000): Promise<void> {
  for (let index = 0; index < maxTurns; index++) {
    if (condition()) {
      return;
    }
    await flushEventLoop(1);
  }

  throw new Error("waitUntil: condition not met in time");
}

function trackPending<T>(pending: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

class SoakServer {
  private readonly wss = new WebSocketServer({ port: 0 });
  private currentSocket: NodeWS | null = null;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectTimers: Array<ReturnType<typeof setTimeout>> = [];

  connectionCount = 0;
  streamedResponses = 0;

  constructor() {
    this.wss.on("connection", (ws) => {
      this.connectionCount++;
      this.currentSocket = ws;
      ws.send(sessionReadyFrame());
      ws.on("message", () => {
        // Sink inbound audio traffic; the soak assertions focus on client-side
        // memory/handle behavior under sustained mixed-direction traffic.
      });
      ws.on("close", () => {
        if (this.currentSocket === ws) {
          this.currentSocket = null;
        }
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.wss.on("listening", () => resolve());
    });

    const address = this.wss.address();
    if (address === null || typeof address === "string") {
      throw new Error("Soak server failed to expose a numeric port");
    }
    return address.port;
  }

  startStreaming(): void {
    if (this.streamTimer !== null) {
      return;
    }

    this.streamTimer = setInterval(() => {
      if (this.currentSocket === null || this.currentSocket.readyState !== NodeWS.OPEN) {
        return;
      }

      this.currentSocket.send(STREAM_RESPONSE_FRAME);
      this.streamedResponses++;
    }, RESPONSE_EVERY_MS);
  }

  scheduleDisconnects(atMs: number[]): void {
    this.disconnectTimers = atMs.map((delayMs) =>
      setTimeout(() => {
        if (this.currentSocket !== null && this.currentSocket.readyState === NodeWS.OPEN) {
          this.currentSocket.close(1012, "synthetic soak disconnect");
        }
      }, delayMs),
    );
  }

  stopStreaming(): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }

    for (const timer of this.disconnectTimers) {
      clearTimeout(timer);
    }
    this.disconnectTimers = [];
  }

  async close(): Promise<void> {
    this.stopStreaming();
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

describe("stream soak", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advanceWithDrain(ms: number, getDelivered: () => number, getSent: () => number) {
    let remaining = ms;
    while (remaining > 0) {
      const stepMs = Math.min(ADVANCE_SLICE_MS, remaining);
      await vi.advanceTimersByTimeAsync(stepMs);
      await flushEventLoop();

      const targetDelivered = getSent();
      await waitUntil(() => getDelivered() >= targetDelivered);

      remaining -= stepMs;
    }
  }

  async function runSoakCase(disconnectAtMs: number[], label: string): Promise<void> {
    if (!(globalThis as GlobalWithGc).gc) {
      throw new Error("test:soak must run with --expose-gc");
    }

    const server = new SoakServer();
    const port = await server.start();
    const baselineHandles = activeHandleCount();
    const pending = new Set<Promise<unknown>>();
    const memorySamples: MemorySample[] = [];
    let responseCount = 0;
    let audioTimer: ReturnType<typeof setInterval> | null = null;

    const client = new OjinClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      apiKey: "test-api-key",
      configId: "test-config-id",
      maxRequestsPerSecond: Infinity,
      reconnectBackoff: { initialMs: 20, maxMs: 20, multiplier: 1, jitter: 0 },
      maxReconnectAttempts: 5,
    });

    try {
      client.events.on(OjinEvent.InteractionResponse, () => {
        responseCount++;
      });

      await client.connect();
      await waitUntil(() => client.connectionState === ConnectionState.Connected);
      await waitUntil(() => server.connectionCount === 1);

      vi.useFakeTimers();
      server.startStreaming();
      server.scheduleDisconnects(disconnectAtMs);

      audioTimer = setInterval(() => {
        if (client.connectionState !== ConnectionState.Connected) {
          return;
        }

        void trackPending(
          pending,
          client.sendAudio(CLIENT_AUDIO_FRAME).catch(() => undefined),
        );
      }, AUDIO_EVERY_MS);

      for (
        let elapsedMs = SAMPLE_EVERY_MS;
        elapsedMs <= SIMULATED_STREAM_MS;
        elapsedMs += SAMPLE_EVERY_MS
      ) {
        await advanceWithDrain(
          SAMPLE_EVERY_MS,
          () => responseCount,
          () => server.streamedResponses,
        );
        await flushEventLoop();
        (globalThis as GlobalWithGc).gc?.();
        await flushEventLoop();

        const usage = process.memoryUsage();
        memorySamples.push({
          elapsedMs,
          heapUsed: usage.heapUsed,
          rss: usage.rss,
        });
      }

      if (audioTimer !== null) {
        clearInterval(audioTimer);
        audioTimer = null;
      }
      server.stopStreaming();

      await waitUntil(() => client.connectionState === ConnectionState.Connected);
      await client.close();
      await vi.advanceTimersByTimeAsync(100);
      await vi.runOnlyPendingTimersAsync();
      await flushEventLoop();
      await Promise.allSettled([...pending]);
      (globalThis as GlobalWithGc).gc?.();
      await flushEventLoop();

      const rssSlope = slopeKbPerMinute(memorySamples, "rss");
      const heapSlope = slopeKbPerMinute(memorySamples, "heapUsed");

      console.log(
        `[soak:${label}] rss slope=${rssSlope.toFixed(1)} KB/min, heap slope=${heapSlope.toFixed(1)} KB/min, responses=${responseCount}, serverConnections=${server.connectionCount}`,
      );

      expect(responseCount).toBeGreaterThanOrEqual(SIMULATED_STREAM_MS / RESPONSE_EVERY_MS / 2);
      expect(server.streamedResponses).toBeGreaterThan(0);
      expect(pending.size).toBe(0);
      expect(activeHandleCount()).toBeLessThanOrEqual(baselineHandles);
      expect(rssSlope).toBeLessThan(RSS_SLOPE_BUDGET_KB_PER_MIN);
      expect(heapSlope).toBeLessThan(HEAP_SLOPE_BUDGET_KB_PER_MIN);

      if (disconnectAtMs.length > 0) {
        expect(server.connectionCount).toBeGreaterThanOrEqual(disconnectAtMs.length + 1);
      }
    } finally {
      if (audioTimer !== null) {
        clearInterval(audioTimer);
      }
      await client.close().catch(() => undefined);
      await server.close();
    }
  }

  it("holds memory and handles steady during 10 simulated minutes of mixed stream traffic", {
    timeout: RESPONSE_TIMEOUT_MS,
  }, async () => {
    await runSoakCase([], "steady");
  });

  it("holds memory and handles steady across 3 synthetic disconnects under sustained load", {
    timeout: RESPONSE_TIMEOUT_MS,
  }, async () => {
    await runSoakCase([3 * 60 * 1000, 6 * 60 * 1000, 9 * 60 * 1000], "reconnect");
  });
});
