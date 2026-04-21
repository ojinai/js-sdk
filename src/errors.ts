/** Error codes for OjinClient errors. */
export enum OjinErrorCode {
  ConnectionFailed = "CONNECTION_FAILED",
  NotConnected = "NOT_CONNECTED",
  ServerNotReady = "SERVER_NOT_READY",
  ProtocolError = "PROTOCOL_ERROR",
  UnknownMessage = "UNKNOWN_MESSAGE",
  ConfigurationError = "CONFIGURATION_ERROR",
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

/** Error thrown when a WebSocket connection fails. */
export class ConnectionError extends OjinError {
  constructor(message: string, details?: unknown) {
    super(message, OjinErrorCode.ConnectionFailed, details);
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
