import { describe, expect, it } from "vitest";
import {
  AuthError,
  BackendUnavailableError,
  OjinError,
  OjinErrorCode,
  RateLimitError,
  TimeoutError,
} from "../../src/errors.js";
import { mapServerError } from "../../src/protocol/error-mapping.js";

// ── Auth codes ────────────────────────────────────────────────────────────────

describe("mapServerError – AUTH_FAILED", () => {
  it("returns instanceof AuthError", () => {
    expect(mapServerError("AUTH_FAILED", "auth failed")).toBeInstanceOf(AuthError);
  });
  it("returns instanceof OjinError", () => {
    expect(mapServerError("AUTH_FAILED", "auth failed")).toBeInstanceOf(OjinError);
  });
  it("code is AUTH_FAILED", () => {
    expect(mapServerError("AUTH_FAILED", "auth failed").code).toBe(OjinErrorCode.AuthFailed);
  });
});

describe("mapServerError – UNAUTHORIZED", () => {
  it("returns instanceof AuthError", () => {
    expect(mapServerError("UNAUTHORIZED", "unauthorized")).toBeInstanceOf(AuthError);
  });
  it("code is UNAUTHORIZED", () => {
    expect(mapServerError("UNAUTHORIZED", "unauthorized").code).toBe(OjinErrorCode.Unauthorized);
  });
});

describe("mapServerError – INVALID_HEADERS", () => {
  it("returns instanceof AuthError", () => {
    expect(mapServerError("INVALID_HEADERS", "bad headers")).toBeInstanceOf(AuthError);
  });
  it("code is INVALID_HEADERS", () => {
    expect(mapServerError("INVALID_HEADERS", "bad headers").code).toBe(
      OjinErrorCode.InvalidHeaders,
    );
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────

describe("mapServerError – RATE_LIMITED", () => {
  it("ticket: returns instanceof RateLimitError", () => {
    expect(mapServerError("RATE_LIMITED", "too many requests")).toBeInstanceOf(RateLimitError);
  });
  it("returns instanceof OjinError", () => {
    expect(mapServerError("RATE_LIMITED", "too many requests")).toBeInstanceOf(OjinError);
  });
  it("code is RATE_LIMITED", () => {
    expect(mapServerError("RATE_LIMITED", "too many requests").code).toBe(
      OjinErrorCode.RateLimited,
    );
  });
});

// ── Backend unavailable ───────────────────────────────────────────────────────

describe("mapServerError – BACKEND_UNAVAILABLE", () => {
  it("returns instanceof BackendUnavailableError", () => {
    expect(mapServerError("BACKEND_UNAVAILABLE", "down")).toBeInstanceOf(BackendUnavailableError);
  });
  it("returns instanceof OjinError", () => {
    expect(mapServerError("BACKEND_UNAVAILABLE", "down")).toBeInstanceOf(OjinError);
  });
  it("code is BACKEND_UNAVAILABLE", () => {
    expect(mapServerError("BACKEND_UNAVAILABLE", "down").code).toBe(
      OjinErrorCode.BackendUnavailable,
    );
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe("mapServerError – TIMEOUT", () => {
  it("returns instanceof TimeoutError", () => {
    expect(mapServerError("TIMEOUT", "timed out")).toBeInstanceOf(TimeoutError);
  });
  it("returns instanceof OjinError", () => {
    expect(mapServerError("TIMEOUT", "timed out")).toBeInstanceOf(OjinError);
  });
  it("code is TIMEOUT", () => {
    expect(mapServerError("TIMEOUT", "timed out").code).toBe(OjinErrorCode.Timeout);
  });
});

// ── Remaining known codes → base OjinError ───────────────────────────────────

describe("mapServerError – base OjinError codes", () => {
  const baseCodeCases: Array<[string, OjinErrorCode]> = [
    ["MISSING_CONFIG_ID", OjinErrorCode.MissingConfigId],
    ["INVALID_MESSAGE", OjinErrorCode.InvalidMessage],
    ["MODEL_NOT_FOUND", OjinErrorCode.ModelNotFound],
    ["INTERNAL_ERROR", OjinErrorCode.InternalError],
    ["FRAME_SIZE_EXCEEDED", OjinErrorCode.FrameSizeExceeded],
    ["CANCELLED", OjinErrorCode.Cancelled],
  ];

  for (const [code, expectedCode] of baseCodeCases) {
    describe(code, () => {
      it("returns instanceof OjinError", () => {
        expect(mapServerError(code, "msg")).toBeInstanceOf(OjinError);
      });
      it("is NOT an AuthError", () => {
        expect(mapServerError(code, "msg")).not.toBeInstanceOf(AuthError);
      });
      it("is NOT a RateLimitError", () => {
        expect(mapServerError(code, "msg")).not.toBeInstanceOf(RateLimitError);
      });
      it("is NOT a BackendUnavailableError", () => {
        expect(mapServerError(code, "msg")).not.toBeInstanceOf(BackendUnavailableError);
      });
      it("is NOT a TimeoutError", () => {
        expect(mapServerError(code, "msg")).not.toBeInstanceOf(TimeoutError);
      });
      it(`code is ${code}`, () => {
        expect(mapServerError(code, "msg").code).toBe(expectedCode);
      });
    });
  }
});

describe("mapServerError – ticket: CANCELLED is base OjinError", () => {
  it("returns base OjinError (not AuthError / RateLimitError / etc.)", () => {
    const err = mapServerError("CANCELLED", "ack");
    expect(err).toBeInstanceOf(OjinError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(BackendUnavailableError);
    expect(err).not.toBeInstanceOf(TimeoutError);
  });
});

// ── Unknown / future codes ────────────────────────────────────────────────────

describe("mapServerError – unknown / future codes", () => {
  it("ticket: FUTURE_NEW_CODE.code preserves raw string", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg").code).toBe("FUTURE_NEW_CODE");
  });
  it("FUTURE_NEW_CODE returns instanceof OjinError", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg")).toBeInstanceOf(OjinError);
  });
  it("FUTURE_NEW_CODE is NOT an AuthError", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg")).not.toBeInstanceOf(AuthError);
  });
  it("FUTURE_NEW_CODE is NOT a RateLimitError", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg")).not.toBeInstanceOf(RateLimitError);
  });
  it("FUTURE_NEW_CODE is NOT a BackendUnavailableError", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg")).not.toBeInstanceOf(BackendUnavailableError);
  });
  it("FUTURE_NEW_CODE is NOT a TimeoutError", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "msg")).not.toBeInstanceOf(TimeoutError);
  });
  it("empty string code is preserved", () => {
    expect(mapServerError("", "msg").code).toBe("");
  });
  it("preserves message for unknown code", () => {
    expect(mapServerError("FUTURE_NEW_CODE", "some message").message).toBe("some message");
  });
});

// ── details propagation ───────────────────────────────────────────────────────

describe("mapServerError – details propagation", () => {
  it("details is set when provided (RateLimitError)", () => {
    const details = { retryAfter: 60 };
    expect(mapServerError("RATE_LIMITED", "too many requests", details).details).toBe(details);
  });
  it("details is undefined when omitted (RateLimitError)", () => {
    expect(mapServerError("RATE_LIMITED", "too many requests").details).toBeUndefined();
  });
  it("details propagated for auth error", () => {
    const details = { realm: "api" };
    expect(mapServerError("AUTH_FAILED", "auth failed", details).details).toBe(details);
  });
  it("details propagated for backend unavailable", () => {
    const details = { model: "gpt-4" };
    expect(mapServerError("BACKEND_UNAVAILABLE", "down", details).details).toBe(details);
  });
  it("details propagated for timeout", () => {
    const details = { after: 30_000 };
    expect(mapServerError("TIMEOUT", "timed out", details).details).toBe(details);
  });
  it("details propagated for base OjinError code (CANCELLED)", () => {
    const details = { reason: "user" };
    expect(mapServerError("CANCELLED", "ack", details).details).toBe(details);
  });
  it("details propagated for unknown code", () => {
    const details = { extra: 42 };
    expect(mapServerError("FUTURE_CODE", "msg", details).details).toBe(details);
  });
});

// ── message propagation ───────────────────────────────────────────────────────

describe("mapServerError – message propagation", () => {
  it("stores message for typed subclass (TimeoutError)", () => {
    expect(mapServerError("TIMEOUT", "request timed out after 30s").message).toBe(
      "request timed out after 30s",
    );
  });
  it("stores message for base OjinError code", () => {
    expect(mapServerError("INTERNAL_ERROR", "something went wrong").message).toBe(
      "something went wrong",
    );
  });
  it("stores message for unknown code", () => {
    expect(mapServerError("FUTURE_CODE", "a future error").message).toBe("a future error");
  });
});
