/**
 * Property-based tests for the WebSocket connection URL builder.
 *
 * Invariant:
 *   For any configId and apiKey — including values that contain URL-reserved
 *   characters such as `?`, `&`, `=`, `#`, `/`, `+`, and full Unicode code
 *   points — the parameters survive the round-trip:
 *
 *     new URL(buildConnectionUrl(wsUrl, configId, apiKey, mode))
 *       .searchParams.get("config_id")  === configId
 *     new URL(buildConnectionUrl(wsUrl, configId, apiKey, mode))
 *       .searchParams.get("api_key")    === apiKey
 *
 *   `buildConnectionUrl` is imported from the production implementation in
 *   `src/utils/url.ts`, which uses `URLSearchParams` for correct
 *   percent-encoding.  Callers that rely on naive template interpolation
 *   (e.g. `` `?config_id=${configId}` ``) will produce broken URLs for inputs
 *   such as `"a/b?c=d"` — fast-check will find such inputs quickly and shrink
 *   them to a minimal counterexample.
 *
 * Mode generator:
 *   `mode` is drawn from `fc.option(fc.string(), { nil: null })` because
 *   `buildConnectionUrl` is a pure encoder — it unconditionally emits any
 *   non-null mode value and the caller (OjinClient.connect) is responsible for
 *   gating emission to `"dev"` only.  Testing the full string range exercises
 *   the encoding path for all characters.
 *
 * Shrinking is left at fast-check's default (enabled).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildConnectionUrl } from "../../src/utils/url.js";

// ─── Property tests ───────────────────────────────────────────────────────────

describe("URL builder property tests", () => {
  it("config_id and api_key survive round-trip regardless of URL-reserved characters", () => {
    fc.assert(
      fc.property(
        // configId and apiKey: full fc.string() range (printable ASCII +
        // common unicode), which includes all URL-reserved characters:
        // ? & = # / : @ ! $ ' ( ) * + , ;
        fc.string(),
        fc.string(),
        // mode: any string or null — the URL builder is a pure encoder so
        // every value round-trips correctly; the caller gates emission.
        fc.option(fc.string(), { nil: null }),
        (configId, apiKey, mode) => {
          const built = buildConnectionUrl("ws://example.com", configId, apiKey, mode);

          // new URL() parses the full URL — this validates that the built
          // string is syntactically valid *and* that URLSearchParams decodes
          // the percent-encoded values back to their original form.
          const parsed = new URL(built);

          expect(parsed.searchParams.get("config_id")).toBe(configId);
          expect(parsed.searchParams.get("api_key")).toBe(apiKey);

          if (mode !== null) {
            expect(parsed.searchParams.get("mode")).toBe(mode);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("escapes a configId that contains URL-reserved characters", () => {
    // Explicit regression guard for the canonical problematic input mentioned
    // in the acceptance criteria: naive template interpolation produces
    // `?config_id=a/b?c=d` which a URL parser truncates at the embedded `?`,
    // yielding `config_id = "a/b"` instead of `"a/b?c=d"`.
    const built = buildConnectionUrl("ws://example.com", "a/b?c=d", "key123", null);
    const parsed = new URL(built);
    expect(parsed.searchParams.get("config_id")).toBe("a/b?c=d");
    expect(parsed.searchParams.get("api_key")).toBe("key123");
  });
});
