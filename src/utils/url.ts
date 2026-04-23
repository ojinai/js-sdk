/**
 * Build a WebSocket connection URL with correct percent-encoding.
 *
 * All parameter values — `configId`, `apiKey`, and the optional `mode` — are
 * encoded via `URLSearchParams` so that URL-reserved characters (e.g. `?`,
 * `&`, `=`, `#`, `/`, `+`, full Unicode code points) in user-supplied strings
 * round-trip correctly through `new URL(built).searchParams.get(key)`.
 *
 * Callers that need to gate `mode` emission (e.g. only when `mode === "dev"`)
 * should pass `null` when the mode parameter should be absent from the URL.
 *
 * @param wsUrl    Base WebSocket URL (e.g. `wss://host/path`).
 * @param configId Config identifier — percent-encoded in the output URL.
 * @param apiKey   API key — percent-encoded as `api_key` in the query string.
 * @param mode     Optional mode string; omitted from the URL when `null`.
 * @returns        A URL string with a properly encoded query string.
 */
export function buildConnectionUrl(
  wsUrl: string,
  configId: string,
  apiKey: string,
  mode: string | null,
): string {
  const params = new URLSearchParams({ config_id: configId, api_key: apiKey });
  if (mode !== null) {
    params.set("mode", mode);
  }
  return `${wsUrl}?${params.toString()}`;
}
