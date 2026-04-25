import { describe, expect, it, vi } from "vitest";

import { OjinEvent, OjinEventEmitter } from "../../src/events.js";
import { ConnectionState } from "../../src/types.js";

describe("OjinEvent values", () => {
  it("uses dotted public event names", () => {
    expect(OjinEvent.ConnectionStateChanged).toBe("session.state_changed");
    expect(OjinEvent.ConnectionOpened).toBe("connection.opened");
    expect(OjinEvent.ConnectionClosed).toBe("session.closed");
    expect(OjinEvent.SessionReady).toBe("session.ready");
    expect(OjinEvent.InteractionResponse).toBe("interaction.response");
    expect(OjinEvent.Error).toBe("interaction.error");
    expect(OjinEvent.WaitingForReady).toBe("session.waiting_for_ready");
    expect(OjinEvent.QueueOverflow).toBe("queue.overflow");
    expect(OjinEvent.Reconnecting).toBe("connection.reconnecting");
    expect(OjinEvent.Reconnected).toBe("connection.reconnected");
  });
});

describe("OjinEventEmitter subscription ergonomics", () => {
  it("returns an unsubscribe function from on()", () => {
    const emitter = new OjinEventEmitter();
    const seen: ConnectionState[] = [];

    const unsubscribe = emitter.on(OjinEvent.ConnectionStateChanged, (state) => {
      seen.push(state);
    });

    emitter.emit(OjinEvent.ConnectionStateChanged, ConnectionState.Connected);
    unsubscribe();
    emitter.emit(OjinEvent.ConnectionStateChanged, ConnectionState.Disconnected);

    expect(seen).toEqual([ConnectionState.Connected]);
  });

  it("treats a second unsubscribe call as a no-op", () => {
    const emitter = new OjinEventEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.on(OjinEvent.ConnectionOpened, listener);

    unsubscribe();

    expect(() => unsubscribe()).not.toThrow();

    emitter.emit(OjinEvent.ConnectionOpened);
    expect(listener).not.toHaveBeenCalled();
  });

  it("fires once() listeners only once", () => {
    const emitter = new OjinEventEmitter();
    const seen: ConnectionState[] = [];

    const unsubscribe = emitter.once(OjinEvent.ConnectionStateChanged, (state) => {
      seen.push(state);
    });

    emitter.emit(OjinEvent.ConnectionStateChanged, ConnectionState.Connected);
    emitter.emit(OjinEvent.ConnectionStateChanged, ConnectionState.Disconnected);

    expect(seen).toEqual([ConnectionState.Connected]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("allows cancelling once() before the first emission", () => {
    const emitter = new OjinEventEmitter();
    const listener = vi.fn();
    const unsubscribe = emitter.once(OjinEvent.ConnectionOpened, listener);

    unsubscribe();
    emitter.emit(OjinEvent.ConnectionOpened);

    expect(listener).not.toHaveBeenCalled();
  });
});
