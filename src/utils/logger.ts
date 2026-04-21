/**
 * Scalar-only metadata accepted by the logger.
 *
 * Deliberately limited to primitives so the redaction path has a fixed,
 * shallow shape — nested objects are rejected at the type level.
 */
export type LoggableMeta = Record<string, string | number | boolean | null>;

/** Supported log levels in ascending severity order. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Injectable logger interface used throughout the SDK.
 *
 * `isLevelEnabled` is load-bearing for hot-path short-circuits: callers can
 * skip expensive meta construction when the level is filtered out.
 */
export interface OjinLogger {
  debug(msg: string, meta?: LoggableMeta): void;
  info(msg: string, meta?: LoggableMeta): void;
  warn(msg: string, meta?: LoggableMeta): void;
  error(msg: string, meta?: LoggableMeta): void;
  isLevelEnabled(level: LogLevel): boolean;
}

// Numeric rank — higher value means more severe.
const LEVEL_RANK: Record<LogLevel | "silent", number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * Create a console-backed OjinLogger that respects the given minimum log level.
 *
 * Passing `"silent"` disables all output and makes `isLevelEnabled` return
 * `false` for every level.
 */
export function createConsoleLogger(level: LogLevel | "silent"): OjinLogger {
  const minRank = LEVEL_RANK[level];

  function isLevelEnabled(l: LogLevel): boolean {
    return LEVEL_RANK[l] >= minRank;
  }

  function emit(fn: (...args: unknown[]) => void, msg: string, meta?: LoggableMeta): void {
    if (meta !== undefined) {
      fn(msg, meta);
    } else {
      fn(msg);
    }
  }

  return {
    debug(msg, meta) {
      if (isLevelEnabled("debug")) emit(console.debug, msg, meta);
    },
    info(msg, meta) {
      if (isLevelEnabled("info")) emit(console.info, msg, meta);
    },
    warn(msg, meta) {
      if (isLevelEnabled("warn")) emit(console.warn, msg, meta);
    },
    error(msg, meta) {
      if (isLevelEnabled("error")) emit(console.error, msg, meta);
    },
    isLevelEnabled,
  };
}

/**
 * A no-op logger that suppresses all output.
 *
 * Exported for test convenience: inject `silent` wherever an OjinLogger is
 * required to keep tests free of console noise.
 */
export const silent: OjinLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  isLevelEnabled() {
    return false;
  },
};
