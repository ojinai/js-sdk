/** Error codes for OjinClient errors. */
export enum OjinErrorCode {
  // ── Server-originated codes (wire strings must match server exactly) ──
  AuthFailed = "AUTH_FAILED",
  Unauthorized = "UNAUTHORIZED",
  MissingConfigId = "MISSING_CONFIG_ID",
  InvalidMessage = "INVALID_MESSAGE",
  InvalidHeaders = "INVALID_HEADERS",
  ModelNotFound = "MODEL_NOT_FOUND",
  BackendUnavailable = "BACKEND_UNAVAILABLE",
  RateLimited = "RATE_LIMITED",
  Timeout = "TIMEOUT",
  Cancelled = "CANCELLED",
  InternalError = "INTERNAL_ERROR",
  FrameSizeExceeded = "FRAME_SIZE_EXCEEDED",
  // ── SDK-local codes ──
  ConnectionFailed = "CONNECTION_FAILED",
  NotConnected = "NOT_CONNECTED",
  ServerNotReady = "SERVER_NOT_READY",
  ProtocolError = "PROTOCOL_ERROR",
  ConfigurationError = "CONFIGURATION_ERROR",
  ReconnectFailed = "RECONNECT_FAILED",
  ReadyTimeout = "READY_TIMEOUT",
  QueueFull = "QUEUE_FULL",
  AudioLocked = "AUDIO_LOCKED",
}

/** Base error class for all Ojin SDK errors. */
export class OjinError extends Error {
  readonly code: OjinErrorCode;
  readonly details?: unknown;

  constructor(message: string, code: OjinErrorCode, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, OjinError.prototype);
  }
}

// ── Existing typed classes (message-first constructor) ────────────────────────

/** Error thrown when a WebSocket connection fails. */
export class ConnectionError extends OjinError {
  constructor(message: string, details?: unknown);
  constructor(message: string, code: OjinErrorCode, details?: unknown);
  constructor(message: string, codeOrDetails?: OjinErrorCode | unknown, details?: unknown) {
    const ojinCodes = new Set<string>(Object.values(OjinErrorCode));
    const hasExplicitCode = typeof codeOrDetails === "string" && ojinCodes.has(codeOrDetails);
    super(
      message,
      hasExplicitCode ? (codeOrDetails as OjinErrorCode) : OjinErrorCode.ConnectionFailed,
      hasExplicitCode ? details : codeOrDetails,
    );
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/** Error thrown when a protocol-level issue occurs. */
export class ProtocolError extends OjinError {
  constructor(message: string, details?: unknown) {
    super(message, OjinErrorCode.ProtocolError, details);
    Object.setPrototypeOf(this, ProtocolError.prototype);
  }
}

/** Error thrown when there is a configuration issue in the SDK. */
export class ConfigurationError extends OjinError {
  constructor(message: string, details?: unknown) {
    super(message, OjinErrorCode.ConfigurationError, details);
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

// ── New typed classes (code-first constructor, caller specifies the code) ─────

/** Error thrown for AUTH_FAILED or UNAUTHORIZED server responses. */
export class AuthError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/** Error thrown when the server enforces rate limiting. */
export class RateLimitError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** Error thrown when the backend model is unavailable. */
export class BackendUnavailableError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, BackendUnavailableError.prototype);
  }
}

/** Error thrown when a server-side operation times out. */
export class TimeoutError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/** Error thrown when the SDK-side ready handshake times out. */
export class ReadyTimeoutError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, ReadyTimeoutError.prototype);
  }
}

/** Error thrown when the outbound send queue is full. */
export class QueueFullError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, QueueFullError.prototype);
  }
}

/** Error thrown when the audio channel is already locked by another caller. */
export class AudioLockedError extends OjinError {
  constructor(code: OjinErrorCode, message: string, details?: unknown) {
    super(message, code, details);
    Object.setPrototypeOf(this, AudioLockedError.prototype);
  }
}
