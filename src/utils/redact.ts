import type { LoggableMeta } from "./logger.js";

/**
 * Top-level keys whose values are replaced with `"***"` by `redactMeta`.
 *
 * Only the top level of `meta` is inspected — nested traversal is intentionally
 * absent. `LoggableMeta` is a scalar-only `Record`, so nested objects are
 * already rejected at the type level. Do not put secrets in nested fields; use
 * flat scalars only.
 */
const SENSITIVE_KEYS = new Set<string>([
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "session_token",
  "sessionToken",
]);

/**
 * Return a shallow copy of `meta` with any sensitive top-level key's value
 * replaced by the literal string `"***"`.
 *
 * Complexity: O(k) where k = number of top-level keys. No nested traversal is
 * performed — `LoggableMeta` forbids nested objects at the type level, so this
 * is both a compile-time and runtime guarantee.
 */
export function redactMeta(meta: LoggableMeta): LoggableMeta {
  let result: LoggableMeta | undefined;

  for (const key in meta) {
    if (Object.hasOwn(meta, key) && SENSITIVE_KEYS.has(key)) {
      // Lazily create the copy only when the first sensitive key is found.
      if (result === undefined) {
        result = { ...meta };
      }
      result[key] = "***";
    }
  }

  // Return the original object if nothing was redacted (avoids an allocation
  // on every call when the meta is clean).
  return result ?? meta;
}

/**
 * Regex that matches `api_key=<value>` in a query string.
 *
 * Matches the literal key `api_key` (case-sensitive) followed by `=` and any
 * run of characters that are not `&` or `#` (i.e. the value up to the next
 * parameter separator or fragment). The replacement leaves the key intact and
 * substitutes the value with `***`.
 *
 * Works correctly for absolute URLs, protocol-relative URLs, relative paths,
 * and bare query strings because it operates on the raw string without relying
 * on the `URL` constructor (which would reject relative inputs).
 */
const API_KEY_PARAM_RE = /(?<=(?:^|[?&])api_key=)[^&#]*/g;

/**
 * Return `url` with the value of any `api_key` query parameter replaced by
 * `***`. The key is matched case-sensitively. All other parameters and the
 * overall URL structure (scheme, host, path, fragment) are preserved.
 *
 * Handles absolute URLs (`https://…`), WebSocket URLs (`wss://…`), relative
 * URLs (`/path?api_key=x`), and bare query strings (`?api_key=x`).
 */
export function redactUrl(url: string): string {
  return url.replace(API_KEY_PARAM_RE, "***");
}
