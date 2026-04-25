import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatencyTracker } from "../../src/utils/profiling.js";

// ─── Lazy Map initialisation ──────────────────────────────────────────────────

describe("LatencyTracker — no module-load side effects", () => {
  afterEach(() => {
    LatencyTracker.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("importing the module does not instantiate any Map", async () => {
    // Reset the module registry so the fresh load is observable.
    vi.resetModules();

    // vi.spyOn is sufficient here: we only assert the spy was never called,
    // so the broken-constructor path is never exercised.
    const MapSpy = vi.spyOn(globalThis, "Map");

    // Dynamic import of the freshly-reset module — no Map should be created.
    await import("../../src/utils/profiling.js");

    expect(MapSpy).not.toHaveBeenCalled();
  });

  it("lazy-initialises shared Maps on first method call, not at module load", () => {
    // Reset nulls all backing fields — no Maps are allocated at this point.
    LatencyTracker.reset();

    // Replace the global Map with a counting subclass so that new Map() calls
    // inside profiling.ts are observable. vi.stubGlobal preserves constructability
    // (the stub is a real class, not a plain function wrapper like vi.spyOn).
    let mapCtorCalls = 0;
    const OriginalMap = Map;
    vi.stubGlobal(
      "Map",
      class extends OriginalMap {
        // biome-ignore lint/suspicious/noExplicitAny: test-only constructor spy
        constructor(...args: any[]) {
          super(...args);
          mapCtorCalls++;
        }
      },
    );

    expect(mapCtorCalls).toBe(0); // No Maps after reset()

    // First method call must trigger lazy Map creation via the getter.
    LatencyTracker.startLatencyMeasure("lazy-probe");

    expect(mapCtorCalls).toBeGreaterThan(0);
  });

  it("reset() does not allocate any Map when called before first use", () => {
    // Replace Map with a counting subclass to observe any allocations.
    let mapCtorCalls = 0;
    const OriginalMap = Map;
    vi.stubGlobal(
      "Map",
      class extends OriginalMap {
        // biome-ignore lint/suspicious/noExplicitAny: test-only constructor spy
        constructor(...args: any[]) {
          super(...args);
          mapCtorCalls++;
        }
      },
    );

    // reset() must only null out backing fields — never call new Map().
    LatencyTracker.reset();

    expect(mapCtorCalls).toBe(0);
  });
});

// ─── Public behaviour — start / stop / stats ─────────────────────────────────

describe("LatencyTracker — start / stop / stats", () => {
  beforeEach(() => {
    LatencyTracker.reset();
  });

  afterEach(() => {
    LatencyTracker.reset();
    vi.restoreAllMocks();
  });

  it("records a positive duration after start → stop", () => {
    LatencyTracker.startLatencyMeasure("req");
    LatencyTracker.stopLatencyMeasure("req");

    expect(LatencyTracker.average("req")).toBeGreaterThanOrEqual(0);
  });

  it("average returns 0 for an unknown measure ID", () => {
    expect(LatencyTracker.average("unknown")).toBe(0);
  });

  it("max returns 0 for an unknown measure ID", () => {
    expect(LatencyTracker.max("unknown")).toBe(0);
  });

  it("min returns 0 for an unknown measure ID", () => {
    expect(LatencyTracker.min("unknown")).toBe(0);
  });

  it("max >= min for a completed sample", () => {
    LatencyTracker.startLatencyMeasure("m");
    LatencyTracker.stopLatencyMeasure("m");

    expect(LatencyTracker.max("m")).toBeGreaterThanOrEqual(LatencyTracker.min("m"));
  });

  it("accumulates across multiple start / stop cycles", () => {
    LatencyTracker.startLatencyMeasure("m");
    LatencyTracker.stopLatencyMeasure("m");
    LatencyTracker.startLatencyMeasure("m");
    LatencyTracker.stopLatencyMeasure("m");

    expect(LatencyTracker.average("m")).toBeGreaterThanOrEqual(0);
    expect(LatencyTracker.max("m")).toBeGreaterThanOrEqual(LatencyTracker.min("m"));
  });

  it("reset clears all stats so every query returns 0", () => {
    LatencyTracker.startLatencyMeasure("m");
    LatencyTracker.stopLatencyMeasure("m");
    LatencyTracker.reset();

    expect(LatencyTracker.average("m")).toBe(0);
    expect(LatencyTracker.max("m")).toBe(0);
    expect(LatencyTracker.min("m")).toBe(0);
  });

  it("stopLatencyMeasure without a prior start is a no-op", () => {
    expect(() => LatencyTracker.stopLatencyMeasure("no-start")).not.toThrow();
    expect(LatencyTracker.average("no-start")).toBe(0);
  });

  it("duplicate start emits a console.warn and discards the older measure", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    LatencyTracker.startLatencyMeasure("dup");
    LatencyTracker.startLatencyMeasure("dup"); // second start without stop

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/dup/);
  });

  it("log() does not throw when no measures have been recorded", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(() => LatencyTracker.log()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("log() emits one line per tracked measure", () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    LatencyTracker.startLatencyMeasure("a");
    LatencyTracker.stopLatencyMeasure("a");
    LatencyTracker.startLatencyMeasure("b");
    LatencyTracker.stopLatencyMeasure("b");
    LatencyTracker.log();

    expect(logSpy).toHaveBeenCalledTimes(2);
  });
});
