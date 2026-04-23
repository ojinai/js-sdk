import {
  AuthError,
  BackendUnavailableError,
  ConnectionError,
  OjinError,
  OjinErrorCode,
  RateLimitError,
  TimeoutError,
} from "../errors.js";

/**
 * Maps a server-originated error code to the appropriate typed error class.
 *
 * Covers all 12 documented server codes:
 *   - AUTH_FAILED, UNAUTHORIZED, INVALID_HEADERS → AuthError
 *   - RATE_LIMITED → RateLimitError
 *   - BACKEND_UNAVAILABLE → BackendUnavailableError
 *   - TIMEOUT → TimeoutError
 *   - MISSING_CONFIG_ID, INVALID_MESSAGE, MODEL_NOT_FOUND, INTERNAL_ERROR,
 *     FRAME_SIZE_EXCEEDED, CANCELLED → base OjinError with matching OjinErrorCode
 *   - Any unknown code → base OjinError with the raw string preserved in .code
 *     (forward-compatible: server may add new codes without requiring SDK updates)
 *
 * This is a pure mapping utility. No events are emitted and no logging occurs here.
 * The caller (WS handler) decides whether to emit OjinEvent.Error.
 */
export function mapServerError(serverCode: string, message: string, details?: unknown): OjinError {
  switch (serverCode) {
    // ── Auth errors ─────────────────────────────────────────────────────────────
    case OjinErrorCode.AuthFailed:
    case OjinErrorCode.Unauthorized:
    case OjinErrorCode.InvalidHeaders:
      return new AuthError(serverCode as OjinErrorCode, message, details);

    // ── Rate limit ───────────────────────────────────────────────────────────────
    case OjinErrorCode.RateLimited:
      return new RateLimitError(OjinErrorCode.RateLimited, message, details);

    // ── Backend unavailable ──────────────────────────────────────────────────────
    case OjinErrorCode.BackendUnavailable:
      return new BackendUnavailableError(OjinErrorCode.BackendUnavailable, message, details);

    // ── Timeout ──────────────────────────────────────────────────────────────────
    case OjinErrorCode.Timeout:
      return new TimeoutError(OjinErrorCode.Timeout, message, details);

    // ── Remaining known server codes → base OjinError ───────────────────────────
    case OjinErrorCode.MissingConfigId:
    case OjinErrorCode.InvalidMessage:
    case OjinErrorCode.ModelNotFound:
    case OjinErrorCode.InternalError:
    case OjinErrorCode.FrameSizeExceeded:
    case OjinErrorCode.Cancelled:
      return new OjinError(message, serverCode as OjinErrorCode, details);

    // ── Unknown / future codes → base OjinError with raw code preserved ──────────
    default:
      return new OjinError(message, serverCode as OjinErrorCode, details);
  }
}

/**
 * Classifies a WebSocket upgrade failure by HTTP status code (Node path via
 * the `ws` library's `unexpected-response` event).
 *
 * - 401 / 403 → AuthError(AuthFailed) with `details.httpStatus`
 * - Any other → ConnectionError(ConnectionFailed) with `details.httpStatus`
 */
export function classifyUpgradeFailureByStatus(statusCode: number): OjinError {
  if (statusCode === 401 || statusCode === 403) {
    return new AuthError(
      OjinErrorCode.AuthFailed,
      `WebSocket upgrade rejected with HTTP ${statusCode}`,
      { httpStatus: statusCode },
    );
  }
  return new ConnectionError(`WebSocket upgrade failed: HTTP ${statusCode}`, {
    httpStatus: statusCode,
  });
}

/**
 * Classifies a WebSocket upgrade failure from a close event (browser path or
 * Node close-before-open, where the HTTP status code is not available).
 *
 * Auth-indicative close conditions (→ AuthError(AuthFailed)):
 *   - close code 1008 (Policy Violation)
 *   - close code 4401 (application convention for "unauthorized")
 *   - close reason containing "auth", "unauthor", or "forbidden" (case-insensitive)
 *
 * All other closes → ConnectionError(ConnectionFailed).
 *
 * Both branches include `details.closeCode` and `details.closeReason` so
 * integrators can branch on specific failure modes.
 */
export function classifyUpgradeFailureByClose(closeCode: number, closeReason: string): OjinError {
  const isAuthClose =
    closeCode === 1008 || closeCode === 4401 || /auth|unauthor|forbidden/i.test(closeReason);

  if (isAuthClose) {
    return new AuthError(
      OjinErrorCode.AuthFailed,
      `WebSocket upgrade rejected: ${closeReason || "authentication failed"}`,
      { closeCode, closeReason },
    );
  }

  return new ConnectionError(
    `WebSocket connection closed during upgrade: ${closeReason || "unknown reason"}`,
    { closeCode, closeReason },
  );
}
