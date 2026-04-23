import { afterEach, describe, expect, it, vi } from "vitest";
import { OjinClient } from "../../src/index.js";
import { MessageType } from "../../src/protocol/session-messages.js";

interface OjinClientInternals {
  handleMessage(data: Uint8Array, isBinary: boolean): void;
  isInboundStale(): boolean;
  lastInboundAtMs: number;
}

function sessionPingFrame(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: MessageType.SessionPing,
      payload: {
        timestamp: Date.now(),
      },
    }),
  );
}

function makeClient(overrides?: Partial<ConstructorParameters<typeof OjinClient>[0]>): OjinClient {
  return new OjinClient({
    wsUrl: "ws://127.0.0.1:65530",
    apiKey: "test-api-key",
    configId: "test-config-id",
    ...overrides,
  });
}

describe("OjinClient inbound-idle tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates lastInboundAtMs for session.ping frames even though no public event is emitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

    const client = makeClient();
    const internals = client as unknown as OjinClientInternals;

    internals.lastInboundAtMs = Date.now();
    vi.setSystemTime(new Date("2026-04-23T12:00:10Z"));
    internals.handleMessage(sessionPingFrame(), false);

    expect(internals.lastInboundAtMs).toBe(Date.parse("2026-04-23T12:00:10Z"));
  });

  it("treats Date.now() silence beyond inboundIdleTimeoutMs as stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

    const client = makeClient({ inboundIdleTimeoutMs: 45_000 });
    const internals = client as unknown as OjinClientInternals;

    internals.lastInboundAtMs = Date.now();
    vi.setSystemTime(new Date("2026-04-23T12:01:30Z"));

    expect(internals.isInboundStale()).toBe(true);
  });

  it("never reports stale while inbound frames keep arriving every 10 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

    const client = makeClient({ inboundIdleTimeoutMs: 45_000 });
    const internals = client as unknown as OjinClientInternals;

    internals.lastInboundAtMs = Date.now();

    for (let step = 1; step <= 6; step++) {
      vi.setSystemTime(new Date(Date.parse("2026-04-23T12:00:00Z") + step * 10_000));
      expect(internals.isInboundStale()).toBe(false);
      internals.handleMessage(sessionPingFrame(), false);
      expect(internals.isInboundStale()).toBe(false);
    }
  });
});
