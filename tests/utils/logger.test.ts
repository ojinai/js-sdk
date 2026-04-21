import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { LoggableMeta, OjinLogger } from "../../src/utils/logger.js";
import { createConsoleLogger, silent } from "../../src/utils/logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function spyAllConsoleMethods() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

// ─── createConsoleLogger — level filtering ────────────────────────────────────

describe("createConsoleLogger — level filtering", () => {
  let spies: ReturnType<typeof spyAllConsoleMethods>;

  beforeEach(() => {
    spies = spyAllConsoleMethods();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops debug when level is "warn"', () => {
    createConsoleLogger("warn").debug("x");
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it('drops info when level is "warn"', () => {
    createConsoleLogger("warn").info("x");
    expect(spies.info).not.toHaveBeenCalled();
  });

  it('passes warn when level is "warn"', () => {
    createConsoleLogger("warn").warn("x");
    expect(spies.warn).toHaveBeenCalledOnce();
  });

  it('passes error when level is "warn"', () => {
    createConsoleLogger("warn").error("x");
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it('passes all levels when level is "debug"', () => {
    const logger = createConsoleLogger("debug");
    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");
    expect(spies.debug).toHaveBeenCalledOnce();
    expect(spies.info).toHaveBeenCalledOnce();
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it('passes only error when level is "error"', () => {
    const logger = createConsoleLogger("error");
    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it('drops all calls when level is "silent"', () => {
    const logger = createConsoleLogger("silent");
    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });
});

// ─── createConsoleLogger — isLevelEnabled ────────────────────────────────────

describe("createConsoleLogger — isLevelEnabled", () => {
  it('reports correct enabled flags when level is "warn"', () => {
    const logger = createConsoleLogger("warn");
    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(logger.isLevelEnabled("warn")).toBe(true);
    expect(logger.isLevelEnabled("error")).toBe(true);
  });

  it('reports all false when level is "silent"', () => {
    const logger = createConsoleLogger("silent");
    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(false);
    expect(logger.isLevelEnabled("warn")).toBe(false);
    expect(logger.isLevelEnabled("error")).toBe(false);
  });

  it('reports all true when level is "debug"', () => {
    const logger = createConsoleLogger("debug");
    expect(logger.isLevelEnabled("debug")).toBe(true);
    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(logger.isLevelEnabled("warn")).toBe(true);
    expect(logger.isLevelEnabled("error")).toBe(true);
  });
});

// ─── createConsoleLogger — meta argument forwarding ──────────────────────────

describe("createConsoleLogger — meta forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards meta when provided", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const meta: LoggableMeta = { key: "value", count: 42, flag: true, nothing: null };
    createConsoleLogger("debug").debug("msg", meta);
    expect(spy).toHaveBeenCalledWith("msg", meta);
  });

  it("omits meta argument when not provided", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    createConsoleLogger("debug").debug("msg");
    expect(spy).toHaveBeenCalledWith("msg");
    expect(spy).not.toHaveBeenCalledWith("msg", undefined);
  });
});

// ─── silent logger ────────────────────────────────────────────────────────────

describe("silent logger", () => {
  let spies: ReturnType<typeof spyAllConsoleMethods>;

  beforeEach(() => {
    spies = spyAllConsoleMethods();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces zero console calls for info and error", () => {
    silent.info("x");
    silent.error("y");
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it("produces zero console calls for all methods", () => {
    silent.debug("x");
    silent.info("x");
    silent.warn("x");
    silent.error("x");
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it("reports isLevelEnabled === false for every level", () => {
    expect(silent.isLevelEnabled("debug")).toBe(false);
    expect(silent.isLevelEnabled("info")).toBe(false);
    expect(silent.isLevelEnabled("warn")).toBe(false);
    expect(silent.isLevelEnabled("error")).toBe(false);
  });

  it("satisfies the OjinLogger interface", () => {
    // Type-level: silent must be assignable to OjinLogger
    expectTypeOf(silent).toMatchTypeOf<OjinLogger>();
  });
});

// ─── LoggableMeta type tests ──────────────────────────────────────────────────

describe("LoggableMeta type", () => {
  it("accepts scalar values at runtime", () => {
    const meta: LoggableMeta = { str: "s", num: 1, bool: true, nil: null };
    expect(meta).toEqual({ str: "s", num: 1, bool: true, nil: null });
  });

  it("rejects nested objects (type-level check via expectTypeOf)", () => {
    // { nested: { a: 1 } } must NOT be assignable to LoggableMeta because
    // { a: number } is not assignable to string | number | boolean | null.
    expectTypeOf<{ nested: { a: number } }>().not.toMatchTypeOf<LoggableMeta>();
  });
});
