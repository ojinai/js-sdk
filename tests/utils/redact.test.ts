import { describe, expect, it } from "vitest";
import type { LoggableMeta } from "../../src/utils/logger.js";
import { redactMeta, redactUrl } from "../../src/utils/redact.js";

// ─── redactMeta — basic redaction ─────────────────────────────────────────────

describe("redactMeta — sensitive key replacement", () => {
  it("redacts apiKey", () => {
    expect(redactMeta({ configId: "abc", apiKey: "s3cret" })).toEqual({
      configId: "abc",
      apiKey: "***",
    });
  });

  it("redacts api_key", () => {
    expect(redactMeta({ configId: "abc", api_key: "s3cret" })).toEqual({
      configId: "abc",
      api_key: "***",
    });
  });

  it("redacts authorization", () => {
    expect(redactMeta({ authorization: "Bearer tok" })).toEqual({ authorization: "***" });
  });

  it("redacts Authorization (capital A)", () => {
    expect(redactMeta({ Authorization: "Bearer tok" })).toEqual({ Authorization: "***" });
  });

  it("redacts session_token", () => {
    expect(redactMeta({ session_token: "tok123" })).toEqual({ session_token: "***" });
  });

  it("redacts sessionToken", () => {
    expect(redactMeta({ sessionToken: "tok123" })).toEqual({ sessionToken: "***" });
  });

  it("leaves non-sensitive keys untouched", () => {
    const meta: LoggableMeta = { x: 1 };
    expect(redactMeta(meta)).toEqual({ x: 1 });
  });

  it("returns the original object reference when nothing is redacted", () => {
    const meta: LoggableMeta = { configId: "abc", count: 42 };
    expect(redactMeta(meta)).toBe(meta);
  });

  it("returns a new object when at least one key is redacted", () => {
    const meta: LoggableMeta = { apiKey: "s3cret", count: 42 };
    expect(redactMeta(meta)).not.toBe(meta);
  });

  it("does not mutate the original object", () => {
    const meta: LoggableMeta = { apiKey: "s3cret" };
    redactMeta(meta);
    expect(meta.apiKey).toBe("s3cret");
  });

  it("handles empty meta", () => {
    expect(redactMeta({})).toEqual({});
  });

  it("redacts multiple sensitive keys in one call", () => {
    expect(
      redactMeta({ apiKey: "k", session_token: "s", configId: "c", Authorization: "a" }),
    ).toEqual({ apiKey: "***", session_token: "***", configId: "c", Authorization: "***" });
  });

  it("preserves null values for non-sensitive keys", () => {
    expect(redactMeta({ flag: null, apiKey: "secret" })).toEqual({ flag: null, apiKey: "***" });
  });

  it("replaces any value type (number, boolean) with the string ***", () => {
    // Unusual but valid: the original value might be a number or boolean.
    const meta: LoggableMeta = { apiKey: 12345 as unknown as string };
    const redacted = redactMeta(meta);
    expect(redacted.apiKey).toBe("***");
  });
});

// ─── redactMeta — does NOT traverse nested objects ────────────────────────────

describe("redactMeta — top-level only (no nested traversal)", () => {
  it("only operates on top-level keys — LoggableMeta prevents nested objects at compile time", () => {
    // At runtime: a plain-object value is technically assignable if cast, but
    // the type system (LoggableMeta = Record<string, string|number|boolean|null>)
    // prevents it. This test documents the runtime shape expectation.
    const safeMeta: LoggableMeta = { region: "eu-west", count: 5 };
    expect(redactMeta(safeMeta)).toEqual({ region: "eu-west", count: 5 });
  });
});

// ─── redactUrl ────────────────────────────────────────────────────────────────

describe("redactUrl — api_key query parameter", () => {
  it("redacts api_key value in a multi-parameter absolute URL", () => {
    expect(redactUrl("wss://host/?config_id=foo&api_key=bar&mode=dev")).toBe(
      "wss://host/?config_id=foo&api_key=***&mode=dev",
    );
  });

  it("leaves URL untouched when api_key is absent", () => {
    const url = "wss://host/?config_id=foo";
    expect(redactUrl(url)).toBe(url);
  });

  it("redacts api_key when it is the first parameter", () => {
    expect(redactUrl("https://example.com/path?api_key=secret&other=val")).toBe(
      "https://example.com/path?api_key=***&other=val",
    );
  });

  it("redacts api_key when it is the only parameter", () => {
    expect(redactUrl("https://example.com/?api_key=only")).toBe("https://example.com/?api_key=***");
  });

  it("handles relative URLs", () => {
    expect(redactUrl("/api/v1/stream?api_key=relkey&mode=fast")).toBe(
      "/api/v1/stream?api_key=***&mode=fast",
    );
  });

  it("handles URLs without a path", () => {
    expect(redactUrl("?api_key=bare")).toBe("?api_key=***");
  });

  it("preserves the URL fragment after api_key", () => {
    expect(redactUrl("https://example.com/?api_key=tok#section")).toBe(
      "https://example.com/?api_key=***#section",
    );
  });

  it("is case-sensitive: does not redact API_KEY (uppercase)", () => {
    const url = "https://example.com/?API_KEY=secret";
    expect(redactUrl(url)).toBe(url);
  });

  it("does not redact keys that merely contain api_key as a substring (prefixed)", () => {
    const url = "https://example.com/?my_api_key=secret";
    expect(redactUrl(url)).toBe(url);
  });

  it("redacts multiple occurrences of api_key in one URL", () => {
    // Unusual but the regex should handle it correctly.
    expect(redactUrl("https://example.com/?api_key=first&x=1&api_key=second")).toBe(
      "https://example.com/?api_key=***&x=1&api_key=***",
    );
  });

  it("leaves other parameters untouched when api_key is present", () => {
    const result = redactUrl("https://example.com/?mode=video&api_key=s3cr3t&region=eu");
    expect(result).toContain("mode=video");
    expect(result).toContain("region=eu");
    expect(result).toContain("api_key=***");
    expect(result).not.toContain("s3cr3t");
  });
});
