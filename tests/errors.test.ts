import { describe, expect, it } from "vitest";
import {
  AudioLockedError,
  AuthError,
  BackendUnavailableError,
  ConfigurationError,
  ConnectionError,
  OjinError,
  OjinErrorCode,
  ProtocolError,
  QueueFullError,
  RateLimitError,
  ReadyTimeoutError,
  TimeoutError,
} from "../src/errors.js";

// ── OjinErrorCode enum ────────────────────────────────────────────────────────

describe("OjinErrorCode – server-originated wire codes", () => {
  it("AUTH_FAILED", () => expect(OjinErrorCode.AuthFailed).toBe("AUTH_FAILED"));
  it("UNAUTHORIZED", () => expect(OjinErrorCode.Unauthorized).toBe("UNAUTHORIZED"));
  it("MISSING_CONFIG_ID", () => expect(OjinErrorCode.MissingConfigId).toBe("MISSING_CONFIG_ID"));
  it("INVALID_MESSAGE", () => expect(OjinErrorCode.InvalidMessage).toBe("INVALID_MESSAGE"));
  it("INVALID_HEADERS", () => expect(OjinErrorCode.InvalidHeaders).toBe("INVALID_HEADERS"));
  it("MODEL_NOT_FOUND", () => expect(OjinErrorCode.ModelNotFound).toBe("MODEL_NOT_FOUND"));
  it("BACKEND_UNAVAILABLE", () =>
    expect(OjinErrorCode.BackendUnavailable).toBe("BACKEND_UNAVAILABLE"));
  it("ticket: RATE_LIMITED", () => expect(OjinErrorCode.RateLimited).toBe("RATE_LIMITED"));
  it("TIMEOUT", () => expect(OjinErrorCode.Timeout).toBe("TIMEOUT"));
  it("CANCELLED", () => expect(OjinErrorCode.Cancelled).toBe("CANCELLED"));
  it("INTERNAL_ERROR", () => expect(OjinErrorCode.InternalError).toBe("INTERNAL_ERROR"));
  it("FRAME_SIZE_EXCEEDED", () =>
    expect(OjinErrorCode.FrameSizeExceeded).toBe("FRAME_SIZE_EXCEEDED"));
});

describe("OjinErrorCode – SDK-local codes", () => {
  it("CONNECTION_FAILED", () => expect(OjinErrorCode.ConnectionFailed).toBe("CONNECTION_FAILED"));
  it("NOT_CONNECTED", () => expect(OjinErrorCode.NotConnected).toBe("NOT_CONNECTED"));
  it("SERVER_NOT_READY", () => expect(OjinErrorCode.ServerNotReady).toBe("SERVER_NOT_READY"));
  it("PROTOCOL_ERROR", () => expect(OjinErrorCode.ProtocolError).toBe("PROTOCOL_ERROR"));
  it("CONFIGURATION_ERROR", () =>
    expect(OjinErrorCode.ConfigurationError).toBe("CONFIGURATION_ERROR"));
  it("RECONNECT_FAILED", () => expect(OjinErrorCode.ReconnectFailed).toBe("RECONNECT_FAILED"));
  it("READY_TIMEOUT", () => expect(OjinErrorCode.ReadyTimeout).toBe("READY_TIMEOUT"));
  it("QUEUE_FULL", () => expect(OjinErrorCode.QueueFull).toBe("QUEUE_FULL"));
  it("AUDIO_LOCKED", () => expect(OjinErrorCode.AudioLocked).toBe("AUDIO_LOCKED"));
});

describe("OjinErrorCode – removed members", () => {
  it("UnknownMessage is not present", () => {
    // Cast to a loose type to verify the member was removed from the enum.
    const codes = OjinErrorCode as Record<string, string | undefined>;
    expect(codes.UnknownMessage).toBeUndefined();
    expect(Object.values(OjinErrorCode)).not.toContain("UNKNOWN_MESSAGE");
  });
});

// ── OjinError base class ──────────────────────────────────────────────────────

describe("OjinError", () => {
  it("is an instance of Error", () => {
    expect(new OjinError("boom", OjinErrorCode.InternalError)).toBeInstanceOf(Error);
  });

  it("stores code and message", () => {
    const err = new OjinError("boom", OjinErrorCode.InternalError);
    expect(err.message).toBe("boom");
    expect(err.code).toBe(OjinErrorCode.InternalError);
  });

  it("stores optional details", () => {
    const details = { trace: "abc" };
    expect(new OjinError("boom", OjinErrorCode.InternalError, details).details).toBe(details);
  });

  it("details is undefined when omitted", () => {
    expect(new OjinError("boom", OjinErrorCode.InternalError).details).toBeUndefined();
  });
});

// ── Existing typed classes ────────────────────────────────────────────────────

describe("ConnectionError", () => {
  it("instanceof OjinError", () => expect(new ConnectionError("fail")).toBeInstanceOf(OjinError));
  it("instanceof ConnectionError", () =>
    expect(new ConnectionError("fail")).toBeInstanceOf(ConnectionError));
  it("code is CONNECTION_FAILED", () =>
    expect(new ConnectionError("fail").code).toBe(OjinErrorCode.ConnectionFailed));
  it("stores details", () =>
    expect(new ConnectionError("fail", { raw: 1 }).details).toEqual({ raw: 1 }));
});

describe("ProtocolError", () => {
  it("instanceof OjinError", () =>
    expect(new ProtocolError("bad frame")).toBeInstanceOf(OjinError));
  it("instanceof ProtocolError", () =>
    expect(new ProtocolError("bad frame")).toBeInstanceOf(ProtocolError));
  it("code is PROTOCOL_ERROR", () =>
    expect(new ProtocolError("bad frame").code).toBe(OjinErrorCode.ProtocolError));
});

describe("ConfigurationError", () => {
  it("instanceof OjinError", () =>
    expect(new ConfigurationError("bad cfg")).toBeInstanceOf(OjinError));
  it("instanceof ConfigurationError", () =>
    expect(new ConfigurationError("bad cfg")).toBeInstanceOf(ConfigurationError));
  it("code is CONFIGURATION_ERROR", () =>
    expect(new ConfigurationError("bad cfg").code).toBe(OjinErrorCode.ConfigurationError));
});

// ── New typed classes ─────────────────────────────────────────────────────────

describe("AuthError", () => {
  it("ticket: instanceof OjinError", () => {
    expect(new AuthError(OjinErrorCode.AuthFailed, "msg")).toBeInstanceOf(OjinError);
  });
  it("instanceof AuthError", () => {
    expect(new AuthError(OjinErrorCode.AuthFailed, "msg")).toBeInstanceOf(AuthError);
  });
  it("stores code and message", () => {
    const err = new AuthError(OjinErrorCode.AuthFailed, "msg");
    expect(err.code).toBe(OjinErrorCode.AuthFailed);
    expect(err.message).toBe("msg");
  });
  it("accepts Unauthorized code", () => {
    const err = new AuthError(OjinErrorCode.Unauthorized, "unauth");
    expect(err.code).toBe(OjinErrorCode.Unauthorized);
    expect(err).toBeInstanceOf(OjinError);
  });
});

describe("RateLimitError", () => {
  it("instanceof OjinError", () => {
    expect(new RateLimitError(OjinErrorCode.RateLimited, "slow down")).toBeInstanceOf(OjinError);
  });
  it("instanceof RateLimitError", () => {
    expect(new RateLimitError(OjinErrorCode.RateLimited, "slow down")).toBeInstanceOf(
      RateLimitError,
    );
  });
  it("code is RATE_LIMITED", () => {
    expect(new RateLimitError(OjinErrorCode.RateLimited, "slow down").code).toBe(
      OjinErrorCode.RateLimited,
    );
  });
});

describe("BackendUnavailableError", () => {
  it("instanceof OjinError", () => {
    expect(new BackendUnavailableError(OjinErrorCode.BackendUnavailable, "down")).toBeInstanceOf(
      OjinError,
    );
  });
  it("instanceof BackendUnavailableError", () => {
    expect(new BackendUnavailableError(OjinErrorCode.BackendUnavailable, "down")).toBeInstanceOf(
      BackendUnavailableError,
    );
  });
  it("code is BACKEND_UNAVAILABLE", () => {
    expect(new BackendUnavailableError(OjinErrorCode.BackendUnavailable, "down").code).toBe(
      OjinErrorCode.BackendUnavailable,
    );
  });
});

describe("TimeoutError", () => {
  it("instanceof OjinError", () => {
    expect(new TimeoutError(OjinErrorCode.Timeout, "timed out")).toBeInstanceOf(OjinError);
  });
  it("instanceof TimeoutError", () => {
    expect(new TimeoutError(OjinErrorCode.Timeout, "timed out")).toBeInstanceOf(TimeoutError);
  });
  it("stores details", () => {
    const err = new TimeoutError(OjinErrorCode.Timeout, "timed out", { after: 5000 });
    expect(err.details).toEqual({ after: 5000 });
  });
});

describe("ReadyTimeoutError", () => {
  it("instanceof OjinError", () => {
    expect(new ReadyTimeoutError(OjinErrorCode.ReadyTimeout, "ready timeout")).toBeInstanceOf(
      OjinError,
    );
  });
  it("instanceof ReadyTimeoutError", () => {
    expect(new ReadyTimeoutError(OjinErrorCode.ReadyTimeout, "ready timeout")).toBeInstanceOf(
      ReadyTimeoutError,
    );
  });
  it("code is READY_TIMEOUT", () => {
    expect(new ReadyTimeoutError(OjinErrorCode.ReadyTimeout, "ready timeout").code).toBe(
      OjinErrorCode.ReadyTimeout,
    );
  });
});

describe("QueueFullError", () => {
  it("instanceof OjinError", () => {
    expect(new QueueFullError(OjinErrorCode.QueueFull, "msg")).toBeInstanceOf(OjinError);
  });
  it("instanceof QueueFullError", () => {
    expect(new QueueFullError(OjinErrorCode.QueueFull, "msg")).toBeInstanceOf(QueueFullError);
  });
  it("ticket: details.queueDepth is accessible", () => {
    const err = new QueueFullError(OjinErrorCode.QueueFull, "msg", { queueDepth: 100 });
    expect((err.details as { queueDepth: number }).queueDepth).toBe(100);
  });
});

describe("AudioLockedError", () => {
  it("instanceof OjinError", () => {
    expect(new AudioLockedError(OjinErrorCode.AudioLocked, "audio locked")).toBeInstanceOf(
      OjinError,
    );
  });
  it("instanceof AudioLockedError", () => {
    expect(new AudioLockedError(OjinErrorCode.AudioLocked, "audio locked")).toBeInstanceOf(
      AudioLockedError,
    );
  });
  it("code is AUDIO_LOCKED", () => {
    expect(new AudioLockedError(OjinErrorCode.AudioLocked, "audio locked").code).toBe(
      OjinErrorCode.AudioLocked,
    );
  });
});
