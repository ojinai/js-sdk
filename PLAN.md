# Ojin TypeScript SDK — Implementation Plan

**Status:** Node-only v1.0 (scope-narrowed 2026-04-21)
**Current version:** `0.1.0`
**Target releases:** `1.0.0` (Node SDK for server-side integration), future browser support deferred
**Reference SDKs reviewed:** Python `ojin-client` (in-tree), Anam AI `@anam-ai/js-sdk@4.12.0`, HeyGen `@heygen/liveavatar-web-sdk@0.0.13`

---

## Scope-Change Notice — 2026-04-21

**v1.0 ships as a Node/server-only SDK.** Apps integrate it from their own backend and expose their own client-facing transport. Direct browser-to-Ojin WebSocket usage is withdrawn from this release.

**Why:** The team has ruled out browser-direct usage of the Ojin WebSocket with API-key auth. API keys in URLs leak via referrer/logs/caches; raw WS has no jitter buffer, FEC, or congestion control for real-time audio; and the Ojin backend has no WebRTC / LiveKit / Daily ingress to build a production browser path against today.

**What this supersedes throughout this document:**

- §2.1 goal "works correctly in a browser" → Node-only; browser is a non-goal until a media-transport ingress exists backend-side.
- §2.3 principle "Browser-first" → replaced by "Server-side first; no client-side WS runtime".
- §3.1 v1.0 framing "Usable in production [from a browser] via query parameter with explicit `unsafe_` naming" → withdrawn; v1.0 is "Usable in production from a Node backend".
- §4.1 "Fix browser auth (D1)" → out-of-scope; browser auth path is removed entirely, not fixed.
- §6.1 "UMD bundle for `<script>` tag consumers" → out-of-scope for v1.0.
- §7.4 "DOM helpers" → indefinite; no longer a v2.0 commitment.
- §10.6 "CSP / Permissions-Policy / COEP deployment recipes" → out-of-scope for v1.0.
- Defects D1, D18, D19 → superseded; see §1.2 annotations.

The rest of the document (wire protocol, error mapping, reconnect, keepalive, queueing, logger, convenience senders, negative-path tests, etc.) still applies to the Node SDK.

**When does browser support come back?** Only after the Ojin backend ships a real media-transport ingress (WebRTC / LiveKit / Daily). No fixed version is committed.

---

## 0. How to read this document

Every item is tagged with:

- **Priority:** P0 (ship-blocker), P1 (GA), P2 (post-GA), P3 (nice-to-have)
- **Release:** 1.0 / 1.5 / 2.0
- **Effort:** S (<½ day), M (½–2 days), L (2–5 days), XL (> 1 week)
- **Risk:** Low / Med / High
- **Breaking:** Yes / No / Deprecation-only

Every fix references a specific file and (where relevant) line range in the current tree so a reviewer can pattern-match against the diff.

---

## 1. Current State Assessment

### 1.1 Strengths worth preserving

| Area | File | Notes |
|---|---|---|
| Isomorphic WS transport | `src/ws-transport.ts`, `src/ws-transport-node.ts` | Platform detection is clean; `ws` kept `external` in Rollup. |
| Typed event emitter | `src/events.ts` | Maps event→callback signature via conditional type; mirrors Anam `PublicEventEmitter`. |
| Error hierarchy | `src/errors.ts` | `Object.setPrototypeOf` handled for multi-target builds. |
| Binary protocol parity | `src/protocol/interaction-messages.ts` | Header sizes match Python; round-trip is symmetric. |
| Build pipeline | `rollup.config.mjs`, `tsconfig.json` | Dual ESM+CJS, types separated, `preserveModules: true` for tree-shaking. |
| Coverage thresholds | `vitest.config.ts` | 80% across lines/functions/branches/statements. |
| Strict TS | `tsconfig.json` | `strict: true`, `isolatedModules: true`. |

### 1.2 Defect inventory (what breaks / what leaks)

| # | Defect | Evidence | Priority |
|---|---|---|---|
| D1 | ~~Browser auth silently fails — native `WebSocket` drops custom `Authorization` header; URL only has `config_id`.~~ **Superseded 2026-04-21:** browser transport removed entirely in Node-only v1.0; no auth path to fix. | `src/ojin-client.ts:76-77`, `src/ws-transport.ts:54-55` | *(superseded)* |
| D2 | `toProxyMessage` throws on 4 of 8 message subclasses; type system cannot distinguish senders from receivers. | `src/protocol/client-messages.ts:39-42,46-49,94-96,198-200` | **P0** |
| D3 | `receiveMessage()` is a Python-asyncio carry-over; duplicates the event path and grows an unbounded queue. Delete outright — events are the only delivery surface. | `src/ojin-client.ts:171-183, 278-285` | **P0** |
| D4 | No reconnection on mid-session drop; initial `reconnectAttempts` is only for the first connect. | `src/ojin-client.ts:263-276` | **P1** |
| D5 | No client-originated keepalive. Node `ws` auto-responds to server pings but doesn't send client pings; browser `WebSocket` exposes no `ping()` API at all. Server-originated `sessionPing` is received and discarded. | `src/ws-transport.ts`, `src/ws-transport-node.ts`, `src/ojin-client.ts:240-242` | **P1** |
| D6 | `sendMessage` throws if `!isServerReady`, but the client is given no `waitForReady()` API and no pre-ready buffer. Tests wire this up by hand. | `src/ojin-client.ts:199-202`, `tests/ojin-client.test.ts:83-96` | **P1** |
| D7 | `Uint8Array<ArrayBuffer>` generic parameter (TS 5.7+ only) in public types — friction for downstream consumers on older TS or using `Buffer`. | `src/protocol/client-messages.ts:57,58,166` | **P1** |
| D8 | Scattered `console.error/warn` — no way for SaaS embedders to silence or redirect. | `src/ojin-client.ts:90,213,223,253,257,259` | **P1** |
| D9 | Audio chunk size hardcoded at 500 KiB. | `src/ojin-client.ts:22` | **P2** |
| D10 | `setNoDelay` reflects into `ws._socket` — brittle against `ws` internals. | `src/ws-transport-node.ts:68-75` | **P2** |
| D11 | `ConnectionClosed` event exposes only `(code, reason)` — no semantic reason. | `src/events.ts:28` | **P1** |
| D12 | `OjinClient.startInteraction()` just drains the queue; Python carry-over. Delete outright. | `src/ojin-client.ts:132-134` | **P0** |
| D13 | `OjinErrorCode` only covers transport; no business-level codes (rate limit, usage cap, backend unavailable). Python already emits `NO_BACKEND_SERVER_AVAILABLE`. | `src/errors.ts:2-9`, cf. `ojin/ojin_client.py:257` | **P1** |
| D14 | ~~Pending `responseResolvers` leak on cancel.~~ Resolved by D3 — `receiveMessage()` deleted outright; resolver bookkeeping goes with it. | `src/ojin-client.ts:139-150, 171-174` | *(resolved by D3)* |
| D15 | `handleMessage` silently discards non-JSON text frames (hitting `console.warn("Unknown message type")` for plain text) and swallows JSON parse failures. Flashhead-lite docs state the server sometimes sends plain-text errors (e.g. *"No backend servers available. Please try again later."*); Python handles that case explicitly at `ojin_client.py:241`. TS must do the same — wrap as `ProtocolError`, populate `details.rawMessage`, and emit `OjinEvent.Error`. | `src/ojin-client.ts:220-225, 257-259` | **P1** (promoted from P2 after docs review) |
| D16 | Mode is stringly typed (`mode === "dev"`); no compile-time guard on valid values. | `src/ojin-client.ts:76`, `src/types.ts:21-22` | **P3** — replace with `type ConnectionMode = "dev" \| "production"` or enum pending §14 Q5. |
| D17 | Event emitter uses raw `console.error` in its handler try/catch — invisible to embedders that set a silent logger. | `src/events.ts:54-57` | **P1** — FE-review finding 25. Emitter takes a logger reference at construction; route caught handler errors through `logger.error`. Grep-in-CI rule forbids raw `console.*` in `src/`. |
| D18 | `FPSTracker` / `LatencyTracker` are exported from the default entry point; top-level `static Map` initialisers can defeat tree-shaking. | `src/index.ts:61`, `src/utils/profiling.ts:96-99` | **P2 (downgraded 2026-04-21)** — Node-only consumers don't bundle-ship, so the tree-shaking motivation is gone. Keeping the move to a `/profiling` subpath as a hygiene/API-surface concern (optional, not GA-blocking); dropping the CI tree-shaking test. |
| D19 | ~~`unsafe_createClientWithApiKey` warn scope is unspecified — "once" could mean per process, per module load, or per call.~~ **Superseded 2026-04-21:** `unsafe_createClientWithApiKey` is not shipped in Node-only v1.0; no warn behaviour to specify. | §4.1 | *(superseded)* |

### 1.3 Strategic gaps vs competitors

**Note (2026-04-21):** Anam and HeyGen are browser-first SDKs fronting WebRTC/LiveKit transports. Since Node-only v1.0 explicitly does not target that surface, most of the original gap analysis no longer applies as a gap — it's a different product shape. The table is kept for context; "v1.0 / v1.5" markers reflect the pre-scope-change plan and are superseded by §2 where they conflict.

| Gap | Anam | HeyGen | Our plan |
|---|---|---|---|
| Session-token auth (server-exchange flow) | Yes, primary | Yes, primary | **v1.5** (deferred) |
| `streamToVideoElement(id)` / `attach(el)` DOM helpers | Yes (WebRTC → `MediaStream`) | Yes (LiveKit → `MediaStream`) | ~~**v2.0**~~ **Deferred indefinitely** — browser surface only; see §7.4. |
| Convenience methods (`talk`, `interrupt`, `sendUserMessage`, `addContext`) | Yes | Yes | **v1.0** |
| Client metrics/telemetry | Yes (opt-out) | — | **Deferred past v1.5** — if shipped, off-by-default. |
| Deprecation warnings on stale fields | Yes (`brainType`→`llmId`) | — | **v1.0** framework |
| Dotted event namespace | — | `session.state_changed` etc. | **v1.0** (shipped native; v0.1 had no public consumers to migrate) |
| UMD bundle for `<script>` tag | Yes (webpack) | Yes (rollup umd) | ~~**v1.0**~~ **Out-of-scope** — browser only; see §6.1. |
| Monorepo / framework adapters | separate repo | Turbo monorepo | **Deferred** alongside browser support. |
| Auto-generated API reference site | — | TypeDoc | **v1.0** |

---

## 2. Goals, Non-Goals, and Guiding Principles

### 2.1 Goals (v1.0)

1. The SDK works correctly in **Node.js 20+** for server-side integration. Apps embed it in their own backend and expose their own client-facing transport.
2. The public API surface is **small, predictable, and correctly typed** — no runtime-throwing methods exposed through the type system.
3. **Single canonical consumption model**: events. Polling is legacy-only and clearly marked.
4. **Connection lifecycle is robust**: reconnect on drop, keepalive, explicit ready state.
5. **Error reporting is actionable**: typed error codes cover business conditions the integrator needs to branch on.
6. **Documentation is sufficient for a new integrator** to ship a Node "hello world" without reading the source.
7. The SDK is **observable**: consumers can inject a logger and catch every failure path.

### 2.2 Non-goals

- **Direct browser / client-side use of the Ojin WebSocket.** Hard block from the team (2026-04-21). Deferred until the backend ships a real media-transport ingress (WebRTC / LiveKit / Daily); no version committed.
- Framework bindings (React hooks, Vue composables, Svelte stores) — revisit only after browser support returns.
- WebRTC transport at the SDK layer — the model-as-API protocol is WebSocket-based; WebRTC, if it happens, lives between a browser and a media-transport service, not between this SDK and Ojin.
- React Native support — deferred alongside browser.
- Server-side helpers (token-exchange microservice) — out of scope; documented as a snippet.
- Breaking the binary wire protocol — any change here needs Python SDK + backend coordination.

### 2.3 Guiding principles

- **Server-side first; no client-side runtime.** The SDK must not be loaded in a browser, mobile app, or any untrusted runtime. Docs and examples only show Node integration patterns.
- **Fail loud on bugs, fail soft on network** — bad code throws; flaky network retries.
- **Never log secrets**. API keys must be redactable or redacted by default in logs and error messages.
- **Deprecate, then delete**. v1.0→v1.5 never removes a public symbol; v2.0 is the planned break.
- **No surprises in the event model**. Every public message has exactly one delivery path.
- **Single-threaded event-loop assumption.** The SDK assumes a single-threaded JavaScript event loop. Public methods are not safe to call concurrently from multiple worker threads against the same client instance; consumers must serialize access.

---

## 3. Release Plan

### 3.1 v1.0.0 — "Usable in production from a Node backend"

Deliverables (all items marked "1.0" in this doc, minus anything the 2026-04-21 scope-change notice supersedes). Node 20+ only; API-key auth via the `ws` package's `headers` option (server-side request, no browser). No session tokens. Browser support is withdrawn from v1.0.

### 3.2 v1.5.0 — "Production-safe auth" (Node-only)

- Session-token auth (`createClient(token)`) alongside v1.0's header-auth factory. Token carried as `Authorization: Bearer <token>` on the Node-side upgrade request.
- Server-side token-exchange reference snippet (Express handler, Next.js API route) — still targeted at Node consumers, intended as a pattern for apps fronting Ojin.
- JWT decode & claim-based config validation.
- Example projects: `examples/node-cli` (browser examples withdrawn alongside browser support).
- Measurable performance targets committed (first-frame latency, reconnect recovery, soak-test memory budget — baselines set during v1.0 run, targets ratified here).

### 3.3 ~~v2.0.0 — "Structural + DOM helpers"~~ — **Placeholder; direction TBD**

The original v2.0 was built around DOM helpers and framework adapters for a browser SDK. Under the 2026-04-21 scope change, there is no browser SDK to build adapters for. v2.0 is deliberately left as a placeholder: if and when the Ojin backend ships a real media-transport ingress (WebRTC / LiveKit / Daily), re-plan v2.0 around that surface. Until then, continued iteration on the Node SDK (session tokens → observability → hardening) is the roadmap.

---

## 4. v1.0 — Critical fixes (P0)

### 4.1 ~~[P0 · Breaking · M · Med risk] Fix browser auth (D1)~~ — **Superseded 2026-04-21**

**This section is withdrawn.** The browser transport is removed in Node-only v1.0; there is no browser auth path to fix. Node-side auth continues to use the `Authorization` header via `ws`'s `headers` option. The remainder of this section is preserved as historical reference only.

<details>
<summary>Historical content (superseded)</summary>

**Problem.** `new WebSocket(url)` in the browser has no API to set headers. The current code sends `Authorization: <apiKey>` only on the Node side; in the browser it's silently dropped and the server receives an unauthenticated connection that only carries `config_id`.

**Proposed solution.**

1. **Transport-agnostic auth = query string.** Construct the URL in `OjinClient.connect()` so the API key is always present:
   ```ts
   const params = new URLSearchParams({ config_id: this.configId });
   if (this.apiKey) params.set("api_key", this.apiKey);
   if (this.mode === "dev") params.set("mode", this.mode);
   const url = `${this.wsUrl}?${params.toString()}`;
   ```
2. **Keep `Authorization` header on both Node and browser** — Python SDK confirms the proxy accepts header auth today. Native browser `WebSocket` cannot set the header, so for the browser path the SDK falls back to `?api_key=…`. **Backend change required if the proxy does not yet accept the query param** — blocker tracked at §14 Q2. No reference SDK resolves this (Python uses header-only; Anam / HeyGen use session tokens, not API keys on the WS URL).
3. **Name the factory `unsafe_createClientWithApiKey`** to match Anam's convention. On first use per JS realm (module-scoped `let warned = false` guard — FE-review finding 20), route the following through the injected logger at `warn` level (not raw `console.warn`):
   > "OjinClient: API-key auth exposes your secret to the client. For production, use session tokens (available in v1.5)."

   **This warning is *not* stripped in production builds.** It is a security signal, not a dev aid — it survives into the production UMD intact.
4. **Redact `api_key` in any URL that appears in logs or error messages** — add a `redactUrl(u: string)` utility and run every log line through it.

**Alternative considered.** `Sec-WebSocket-Protocol` subprotocol hack (`new WebSocket(url, [`Bearer.${apiKey}`])`). Rejected because:
- Server would need additional parsing logic.
- Subprotocol is exposed in browser devtools just like a query param.
- Query-param approach is exactly what Anam chose.

**Files touched.** `src/ojin-client.ts`, `src/ws-transport.ts`, `src/index.ts` (export factory), `src/utils/redact.ts` (new), `README.md`.

**Tests.**
- URL-builder unit test (api_key present, mode dev, mode absent).
- Integration: mock WS server reads `?api_key=` from upgrade URL.
- Redaction test: inject `apiKey=supersecret` into a URL, assert it's `api_key=***`.
- Browser smoke test (happy-dom) asserting no header is passed and URL contains `api_key`.

**Risk.** Backend must accept `api_key` query param. **Mitigation:** confirmed with backend team before merge (§14 Q2). If backend wants `Sec-WebSocket-Protocol` instead, swap implementation without changing factory signature.

</details>

---

### 4.2 [P0 · Breaking · M · Low risk] Split `OjinMessage` into client/server hierarchies (D2)

**Problem.** Four server-bound subclasses implement `toProxyMessage()` as `throw new Error("Method not implemented.")`. The type system says you can serialize any `OjinMessage`, but you can't. This is a typed lie.

**Proposed solution.**

```ts
// src/protocol/client-messages.ts
export abstract class OjinMessage { /* marker only */ }

export abstract class OjinClientMessage extends OjinMessage {
  /** Logical proxy-message representation (for debugging / logging). */
  abstract toMessage(): unknown;          // replaces the partially-implemented toProxyMessage
  /** Serialized wire form (binary for audio/text, JSON for end/cancel). */
  abstract toBytes(): string | Uint8Array;
}

export abstract class OjinServerMessage extends OjinMessage {}
```

- `OjinTextInputMessage`, `OjinAudioInputMessage`, `OjinCancelInteractionMessage`, `OjinEndInteractionMessage` extend `OjinClientMessage`.
- `OjinSessionReadyMessage`, `OjinInteractionResponseMessage`, `OjinErrorResponseMessage`, `OjinSessionReadyPing` extend `OjinServerMessage` — these never serialize outbound, so no `toMessage`/`toBytes`.
- `sendMessage` signature changes to `sendMessage(message: OjinClientMessage)`.
- Why keep both `toMessage` and `toBytes`: the logical shape is useful for debugging and for future protocol additions that may need logical-then-serialize separation. Folding them into a single `toWire()` was considered and rejected.

**Migration.**
- `toProxyMessage` removed where it currently throws (server messages); renamed to `toMessage` where it had a real implementation (client messages).
- Old `toBytes()` keeps its name and semantics on client messages.
- Typed error at compile time if someone passes an `OjinServerMessage` to `sendMessage`.
- CHANGELOG documents migration; rely on the TS compiler's `@deprecated` JSDoc diagnostic (no Biome custom rule).

**Files touched.** `src/protocol/client-messages.ts`, `src/ojin-client.ts`, `src/index.ts`.

**Tests.**
- Compile-time test: `expectTypeOf<Parameters<OjinClient["sendMessage"]>[0]>().not.toMatchTypeOf<OjinServerMessage>()`.
- Each client message round-trips through the server harness.

---

### 4.3 [P0 · Breaking · S · Low risk] Delete `receiveMessage()` and `startInteraction()` (D3, D12, D14)

**Problem.** Every server message is simultaneously enqueued (`responseQueue`/`responseResolvers`) **and** emitted as an event. Consumers who use both get duplicates; consumers who use neither grow an unbounded queue. The polling API is a Python-asyncio carry-over that no industry TS/JS SDK exposes.

**Proposed solution.** **Events are the only delivery path. Delete both methods outright** — no deprecation dance, no opt-in flag, no internal queue. v0.1 has no public consumers, so there's nothing to migrate.

- Remove `OjinClient.receiveMessage()` and the associated `responseQueue` / `responseResolvers` bookkeeping.
- Remove `OjinClient.startInteraction()` — events fire directly on message arrival; no drainage step is needed.
- D14 (pending resolvers on cancel) disappears with the resolver array.

**Files touched.** `src/ojin-client.ts`, `src/index.ts` (drop re-exports), `src/events.ts`.

**Tests.**
- Every server message type produces exactly one event emission.
- No unbounded growth over 10 000 inbound messages with no listeners attached (messages drop on the floor — events are fire-and-forget by design).
- `connect()` → `cancelInteraction()` → `close()` leaves no pending promises (regression test for D14).

---

### 4.4 [P0 · Non-breaking · S · Low risk] Bound the outgoing send queue

Before `SessionReady` (§4.5) and during reconnect (§5.1), outgoing messages are buffered. The buffer needs a hard memory bound.

**Config shape (FE-review finding 12).** The original flat `maxPendingOutgoing` option was renamed to a nested object so the direction is grammatically explicit at the call site — guarding against future additions of a matching incoming-side control:

```ts
outgoingQueue?: {
  maxMessages?: number;                                // default 100
  onOverflow?: "reject" | "dropOldest" | "dropNewest"; // default "reject" — see finding 11
};
```

**Outgoing overflow** (default `"reject"` — finding 11: interactive chat cannot survive drop-oldest on user input): `sendMessage` promise rejects with a new typed error `QueueFullError extends OjinError` (added in §5.4) carrying `details.queueDepth` and `details.maxMessages`. Telemetry-style consumers who want fire-and-forget semantics opt into `"dropOldest"` or `"dropNewest"` explicitly; those paths emit `OjinEvent.QueueOverflow` with `{ dropped: N }` (rate-limited once per 5-second window).

---

### 4.5 [P0 · Behaviourally breaking · M · Low risk] `waitForReady()` + pre-ready send buffer (D6)

**Problem.** `sendMessage` throws if `!isServerReady`. The server sends `SessionReady` *after* the WS opens — there's a ~50–500 ms window where `connect()` resolved but sends still fail. Consumers must wire up the event manually; test harness already does this.

**Proposed solution.**

1. **`waitForReady(timeoutMs?: number): Promise<OjinSessionReadyMessage>`** — resolves immediately if already ready; otherwise resolves on the next `SessionReady` event; rejects on timeout (see below) or on `close()` called during the wait. Cancellation is load-bearing: the wait listens on the same `AbortController` used by reconnect sleeps (§5.1) so a concurrent `close()` rejects the promise deterministically.
2. **`autoWaitForReady` option — default flipped to `false` (FE-review finding 5).** Original default of `true` silently converted `sendMessage`'s contract from "throws" to "buffers forever," making misconfiguration invisible. New default preserves v0.1's loud throw-on-not-ready semantics. Consumers who want the buffering behaviour opt in explicitly.
3. **When `autoWaitForReady: true`:**
   - Emit a new `OjinEvent.WaitingForReady` (added to Appendix A) the first time a `sendMessage` call blocks on ready — gives UIs a signal to render a spinner rather than hang silently.
   - On timeout, throw `ReadyTimeoutError` (new typed error, distinct from the generic `TimeoutError` in §5.4) carrying `details.configId`, `details.elapsedMs`, and `details.lastConnectionState`. Surfaces the common "bad `configId`" mis-configuration clearly.
4. **Pending outgoing queue** (bounded, configured via `outgoingQueue.maxMessages`, default 100 — see §4.4): messages submitted before `SessionReady` are queued when `autoWaitForReady: true`, flushed in order on ready. Matches Python's `_pending_client_messages_queue` semantics. When `autoWaitForReady: false`, no queueing — `sendMessage` throws immediately.

**Files touched.** `src/ojin-client.ts`.

**Tests.**
- `autoWaitForReady: true` + `sendMessage` called immediately after `connect()` → succeeds after `SessionReady` is mocked with a 100 ms delay.
- `WaitingForReady` event fires exactly once per wait span, not per buffered message.
- `waitForReady(50)` rejects with `ReadyTimeoutError` when the server never sends `SessionReady`; error carries `elapsedMs ≥ 50`, `lastConnectionState === "Connecting"`, and the configured `configId`.
- Default `autoWaitForReady: false` preserves the throw-on-not-ready behaviour from v0.1.
- `close()` during an in-flight `waitForReady()` rejects with `ConnectionError(NotConnected)` — not a hang (FE-review finding 18).

---

### 4.6 [P0 · Non-breaking · S · Low risk] Simplify `Uint8Array` generic parameter (D7)

Remove `Uint8Array<ArrayBuffer>` — use plain `Uint8Array`. TS 5.7 introduced the generic parameter but older toolchains and Node's `Buffer` interop do not. The SDK receives no value from the tighter type.

Widening a type parameter is covariant-safe for consumers — they do not get a compile error when the API loosens. Hence non-breaking.

**Files touched.** `src/protocol/client-messages.ts`, `src/protocol/interaction-messages.ts`.

**Risk.** Zero — it's a type-level narrowing being removed.

---

## 5. v1.0 — High-value improvements (P1)

### 5.1 [P1 · Non-breaking · L · Med risk] Auto-reconnect with backoff (D4)

**Behaviour.**

- New option `autoReconnect: boolean` (default `true`).
- **Split retry-count fields (Anam precedent `maxWsReconnectionAttempts`).** Existing `reconnectAttempts` becomes `initialConnectAttempts` (default `3`) — bounds retries during the first `connect()`. New `maxReconnectAttempts` (default `5`) bounds retries after a live drop. They are independent because the failure modes and tolerable latencies differ.
- New option `reconnectBackoff: { initialMs, maxMs, multiplier, jitter }` with defaults `{ 500, 30_000, 2, 0.3 }`.
- On unexpected `close`, enter `Reconnecting` state:
  - Emit `ConnectionStateChanged(Reconnecting)` and `Reconnecting(attempt, delayMs)`.
  - Sleep `min(initial * multiplier^attempt, max) * (1 ± jitter)`.
  - Retry `connect()` up to `maxReconnectAttempts` times.
  - On success, emit `Reconnected` + auto re-await `SessionReady`.
  - On final failure, emit `ConnectionClosed` with `DisconnectReason.ReconnectFailed`.
- **No-retry decision is driven by `ErrorResponse.code`, not WS close codes.** The flashhead-lite docs define 12 application-level error codes delivered on the live socket before the close (§5.4). If the most recent `ErrorResponse` before the close had a code in the no-retry set — `AUTH_FAILED`, `UNAUTHORIZED`, `MISSING_CONFIG_ID`, `INVALID_MESSAGE`, `INVALID_HEADERS`, `MODEL_NOT_FOUND`, `FRAME_SIZE_EXCEEDED` — the SDK does **not** reconnect. It emits `ConnectionClosed` with the mapped `DisconnectReason` and stays down. Otherwise retry proceeds.
- **Bare close with no preceding `ErrorResponse`** (e.g. network drop, TLS reset) is treated as transient and retried. WS close codes (§14 Q6) remain undocumented but are not load-bearing — the app-level signal is stronger and arrives first.
- **Cancellation is load-bearing (FE-review finding 18).** Every internal `await sleep(ms)` inside the reconnect loop, the backoff wait, and `waitForReady` runs on a shared per-instance `AbortController`. `close()` aborts the controller; every sleep rejects with a shared `OperationAborted` error that the reconnect loop treats as "stop, stay disconnected." Without this, a `close()` during a 30 s backoff fires a reconnect 30 s later against a closed client.
- **`maxReconnectAttempts` counter resets to zero on every successful reconnect (finding 18).** The limit is "N drops in a row," not "N drops per session lifetime." Otherwise a long-running session slowly burns through the budget and goes silent hours later.

**New states** — extend `ConnectionState` enum: `Reconnecting`.
**New events** — `Reconnecting`, `Reconnected`.
**Outgoing messages in flight during reconnect:** buffered in the pending-outgoing queue (§4.5), capped at `outgoingQueue.maxMessages` (§4.4); overflow follows `outgoingQueue.onOverflow` (default: reject with `QueueFullError`).

**Files touched.** `src/ojin-client.ts`, `src/types.ts`, `src/events.ts`.

**Tests.**
- Server closes socket unexpectedly — client reconnects within backoff window, receives fresh `SessionReady`, state returns to `Connected`.
- Backoff monotonically increases up to `maxMs`; honours `maxReconnectAttempts` independently of `initialConnectAttempts`.
- Jitter present (statistical test: 100 runs, spread ≥ 10% of nominal delay).
- Once the backend close-code table is defined (§14 Q), add a test per code on whether retry is attempted.

**Risk.** Server could reject rapid reconnects (rate-limit). **Mitigation:** jitter + exponential backoff + `maxReconnectAttempts` bound.

---

### 5.2 [P1 · Non-breaking · M · Med risk] Keepalive / heartbeat (D5)

**Problem.** Browsers don't let us control WS ping frames. Intermediaries close idle connections silently. The Ojin proxy already emits inbound `sessionPing` on a regular cadence (handled at `ojin-client.ts:240`) — currently discarded. **On top of that, browser timers are unreliable under real user conditions** (FE-review findings 1, 2): Chromium throttles `setTimeout` to 1 Hz in background tabs; iOS Safari freezes timers entirely under Low Power Mode or screen-lock; Safari BFCache suspends the event loop without firing `close`. A `setTimeout`-based idle check that works on a laptop does not work on a phone. The original passive-liveness design had to be re-anchored to wall-clock time and event-driven checkpoints.

**Proposed design — event-driven liveness, wall-clock anchored.**

Liveness is **computed from the last inbound frame's wall-clock timestamp**, not driven by a long-running `setTimeout`:

- Every inbound frame (any type: `InteractionResponse`, `SessionReady`, `SessionPing`, `ErrorResponse`) updates `lastInboundAtMs = Date.now()`. `Date.now()` is wall-clock and advances across tab suspension, unlike `performance.now()` which may pause. A `performance.now()` shadow is recorded for drift diagnostics only.
- The liveness check itself is `Date.now() - lastInboundAtMs > inboundIdleTimeoutMs`. It runs **opportunistically**:
  - On every inbound frame (cheap; used for fast recovery when frames resume after a gap).
  - On every browser event that signals the tab is active: `document.visibilitychange` when transitioning to `visible`, `window` `pageshow`, `focus`, `online`.
  - On a belt-and-braces `setTimeout` watchdog (timer may throttle or suspend — it is **not** the authority).
- On any stale check: transition to `Reconnecting`, tear down the transport, kick the reconnect state machine (§5.1) synchronously — do not wait for a throttled timer to catch up.

**BFCache handling (Safari) — FE-review finding 2.** BFCache is a distinct lifecycle event requiring its own treatment, promoted here from a one-liner in R11:

- **`pagehide` with `event.persisted === true`** → proactively call `transport.close()` and set state to `Disconnected` (not `Reconnecting`). Prevents returning to a half-alive socket.
- **`pageshow` with `event.persisted === true`** → unconditionally re-enter the reconnect state machine, regardless of what `lastInboundAtMs` says. BFCache restore happens silently; the wall-clock check alone cannot distinguish "returned from BFCache" from "normal foregrounding."
- **`pagehide` with `persisted === false`** (normal unload) → fire-and-forget `close()` so the server gets a clean disconnect.
- Chromium does not BFCache active WebSockets; this branch is de-facto Safari-only but costs nothing to run everywhere.

**Node path** additionally sends active pings (belt-and-braces, not load-bearing for correctness):

- Client calls `ws.ping()` every `heartbeatIntervalMs` (default `30_000`); pong consumed automatically by `ws`.
- **Interval lifecycle (FE-review finding 17):** stored on the instance; **cleared in `close()` before the transport is nulled**; cleared at the start of every reconnect attempt; restarted after successful reconnect. The interval uses `.unref()` so it never keeps the Node process alive past `close()`.
- Failures in `ws.ping()` do not directly drive the state machine — the inbound-idle check remains the authoritative signal.

**Defaults.**
- `inboundIdleTimeoutMs` — default `45_000`. Must exceed the server's `sessionPing` cadence with headroom (see §14 Q8).
- `heartbeatIntervalMs` (Node only) — default `30_000`.

**Files touched.** `src/ws-transport.ts`, `src/ws-transport-node.ts`, `src/ojin-client.ts`, new `src/utils/page-lifecycle.ts` (encapsulates the `visibilitychange` / `pageshow` / `pagehide` / `focus` / `online` subscriptions behind a feature-detected no-op for Node).

**Tests.**
- Mock server stops emitting anything after connect — client detects within `inboundIdleTimeoutMs` and triggers reconnect.
- Mock server emits only `sessionPing` every 30 s — client stays connected indefinitely (fake timers, 10 simulated minutes).
- Node path: mock server never sends pongs but keeps sending frames — client stays connected (proves pong path is not load-bearing).
- Timeout is measured from **last inbound frame**, not from connect time (regression test).
- **Background-tab simulation (finding 1):** `vi.useFakeTimers()` + manual `Date.now()` advance of 90 s while the tab is simulated as "hidden" (no firing setTimeouts); foreground via synthetic `visibilitychange` event; assert reconnect begins synchronously on foregrounding — not on the next timer tick.
- **BFCache Playwright test (finding 2 + R11):** Playwright on WebKit navigates away from the SDK page and returns via the browser back button (BFCache enabled). Assert `pagehide.persisted === true` closed the socket and `pageshow.persisted === true` entered reconnect. Promoted into §15.1 acceptance criteria.
- **Node ping-interval cleanup (finding 17):** call `connect()` then `close()`; assert `process._getActiveHandles().length` (or Vitest's `--detectOpenHandles`) is unchanged — no leaked interval.

**Alternative considered.** Active client-to-server pings with required server echo. Rejected because the Ojin proxy does not currently echo client pings; adding a backend dependency gave no additional safety over wall-clock-anchored passive detection.

---

### 5.3 [P1 · Non-breaking · S · Low risk] Injectable logger (D8)

```ts
export type LoggableMeta = Record<string, string | number | boolean | null>;

export interface OjinLogger {
  debug(msg: string, meta?: LoggableMeta): void;
  info(msg: string,  meta?: LoggableMeta): void;
  warn(msg: string,  meta?: LoggableMeta): void;
  error(msg: string, meta?: LoggableMeta): void;
  isLevelEnabled(level: "debug" | "info" | "warn" | "error"): boolean;
}

export interface OjinClientOptions {
  // …
  logger?: OjinLogger;      // default: console-backed
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";  // default: warn
}
```

**Implementation notes.**

- Default: `createConsoleLogger(level)` — respects level filter.
- `silent` logger: no-ops; must be exported for test convenience.
- All SDK `console.*` calls replaced with `this.logger.*` — **including the event emitter's try/catch around consumer handlers (FE-review finding 25)**. The current `events.ts:54-57` uses raw `console.error` which is invisible to an embedder that set `logger: silent`. Fix: emitter takes a logger reference at construction and routes caught handler errors through `logger.error`. A grep-in-CI rule enforces "no `console.*` in `src/`."
- **Hot-path short-circuit (FE-review finding 13).** Every SDK call site at `debug` or `info` level must be wrapped in `if (this.logger.isLevelEnabled("debug")) this.logger.debug(...)`. Without the guard, the `meta` object is constructed and redacted on every call regardless of output destination. At 25 fps with multiple log calls per frame, this is >100 redaction passes/second for output that never appears.
- **Redaction strategy — specified, not implied (FE-review finding 14).** Key-whitelist walk of the **top level** of `meta` only (O(k) where k = number of top-level keys). Replace any key in `{"apiKey", "api_key", "authorization", "Authorization", "session_token", "sessionToken"}` with `"***"`. **Nested objects are not traversed** — document as an explicit constraint of the `LoggableMeta` type: "do not put secrets in nested fields; use flat scalars only." The `LoggableMeta` type itself forbids nested objects at the compile level — a scalar-only `Record`. Forbid `OjinMessage` / `Uint8Array` as `meta` values (both are covered by the scalar restriction). Regex-over-JSON redaction is **explicitly rejected**: a passed-through video frame would serialise to a multi-MB JSON string and the regex scan would cost more than a frame period on mobile.
- URL redaction (separate path from `meta`) continues through `redactUrl()` (§4.1) applied to log messages that contain URLs.

**Files touched.** All `console.*` call sites; new `src/utils/logger.ts`, `src/utils/redact.ts`; `src/events.ts` (emitter takes logger).

**Tests.**
- Custom logger receives N messages for N operations.
- Silent logger produces zero output during full connect/send/close cycle.
- Redaction: `logger.info("x", { apiKey: "s3cret" })` leaves `s3cret` out of the captured meta; asserts replacement value is `"***"`.
- `LoggableMeta` type check rejects nested objects (tsd / `expectTypeOf` test).
- Event-emitter handler error (a consumer listener throws) is routed to `logger.error`, **not** `console.error` (finding 25). Silent logger + throwing listener → no console output at all; but `logger.error` was invoked.
- Hot-path short-circuit: with `logLevel: "warn"`, `logger.debug(...)` calls from `handleMessage` measurably cost near zero (Vitest bench asserts ≤ 100 ns per call on Node 20). Proves the `isLevelEnabled` guard works.
- Redaction bench: 20 top-level keys processed in ≤ 1 µs.

---

### 5.4 [P1 · Non-breaking · S · Low risk] Expanded error codes (D13)

**Design.** The flashhead-lite API docs define 12 application-level error codes delivered on `ErrorResponse.payload.code`. HTTP upgrade codes (101, 401) cover handshake-time failures. WS close codes are undocumented and **not load-bearing** — the SDK drives behaviour off `ErrorResponse.code`, which is the stronger signal and arrives first.

**Documented server codes** (1:1 mapping — string values match server wire codes):

| Server code | SDK code | Retryable? | Notes |
|---|---|---|---|
| `AUTH_FAILED` | `AuthFailed` | No | Invalid API key |
| `UNAUTHORIZED` | `Unauthorized` | No | Caller lacks permission |
| `MISSING_CONFIG_ID` | `MissingConfigId` | No | Programmer error — missing query param |
| `INVALID_MESSAGE` | `InvalidMessage` | No | Programmer error — malformed payload |
| `INVALID_HEADERS` | `InvalidHeaders` | No | Missing / invalid `Authorization` |
| `MODEL_NOT_FOUND` | `ModelNotFound` | No | Config ID does not exist |
| `BACKEND_UNAVAILABLE` | `BackendUnavailable` | **Yes** (backoff) | No healthy inference backend |
| `RATE_LIMITED` | `RateLimited` | **Yes** (throttle) | **Server cap: 6 requests/sec per connection** |
| `TIMEOUT` | `Timeout` | **Yes** | Server-side operation exceeded processing time |
| `CANCELLED` | `Cancelled` | Expected | Normal response to client-initiated `CancelInteraction` (see below) |
| `INTERNAL_ERROR` | `InternalError` | **Yes** | Unexpected server fault |
| `FRAME_SIZE_EXCEEDED` | `FrameSizeExceeded` | No | Client sent > 512 KB (§5.6) |

**Additional SDK-only codes** (local):

| SDK code | Source |
|---|---|
| `ConnectionFailed` | WS upgrade refused or network error |
| `NotConnected` | `sendMessage` called before `connect()` |
| `ServerNotReady` | `sendMessage` before `SessionReady` when `autoWaitForReady: false` |
| `ProtocolError` | Unparseable frame, plain-text error, binary/JSON flag mismatch |
| `ConfigurationError` | Invalid option at construction |
| `ReconnectFailed` | All reconnect attempts exhausted |

**Typed error classes.** Consumers want to `catch` by category, not by every code. Minimal set:

- `AuthError` — covers `AuthFailed`, `Unauthorized`, `InvalidHeaders`, and HTTP 401 upgrade failures.
- `RateLimitError` — covers `RateLimited`.
- `BackendUnavailableError` — covers `BackendUnavailable`.
- `TimeoutError` — covers `Timeout` (both local and server-originated).
- `ConnectionError`, `ProtocolError`, `ConfigurationError` — existing transport / local cases.

Remaining codes (e.g. `ModelNotFound`, `InternalError`, `FrameSizeExceeded`) surface as the base `OjinError` with the `.code` field.

**`CANCELLED` is not an error.** It's the server's acknowledgement of a client-initiated `CancelInteraction`. The SDK consumes it silently (debug-level log); it does **not** emit `OjinEvent.Error`. Surfacing it as an error would be misleading.

**Rate limit — 6 requests/sec per connection** (documented). Add an `OjinClientOptions.maxRequestsPerSecond` option (default `6`, set to `Infinity` to disable) that client-side throttles `sendMessage` to avoid tripping `RATE_LIMITED` in normal operation. When the server still replies with `RATE_LIMITED`, the SDK retries with a short backoff. Note: the limit is on *outbound client messages*, not audio bytes — the 500 KB chunk size default is compatible (one audio utterance = one chunk = one request).

**Throttle scope (FE-review finding 24).** The client-side throttle resets to zero on every `ConnectionOpened` — it is a per-connection-instance budget, not a session-lifetime budget. If the server's real rate limit is per-account (undocumented), the SDK's throttle is a best-effort mitigation and `RATE_LIMITED` can still fire; this is acknowledged in the code's comments and the README rate-limit section. If feedback from production shows the client-side throttle causes more harm than good (false back-pressure when the server is fine), we reserve the right to ship a patch release that sets the default to `Infinity` and relies on server enforcement.

**`QueueFullError`** — new typed error, thrown by `sendMessage` when the outgoing queue (§4.4) rejects with `onOverflow: "reject"` (the new default for outgoing, FE-review finding 11). Carries `details.queueDepth`, `details.maxMessages`. Code value: `OjinErrorCode.QueueFull = "QUEUE_FULL"` — SDK-local, never server-originated.

**Plain-text error mode** — see D15. Server may send non-JSON text (e.g. *"No backend servers available."*); Python handles this at `ojin_client.py:241`. TS wraps as `ProtocolError` with `details.rawMessage`, emits `OjinEvent.Error`.

**Files touched.** `src/errors.ts`, new `src/protocol/error-mapping.ts`, `src/ojin-client.ts` (`handleMessage` for plain-text branch + rate-limit throttle), `src/index.ts` (re-exports).

**Tests.**
- Each of the 12 documented codes: server sends code X → SDK emits `OjinEvent.Error` with the mapped code and typed error class. Exception: `CANCELLED` produces no error event.
- Unknown server code falls through to the base `OjinError` with original string preserved in `.code` (forward-compatible if the server adds new codes — the mapping is open, not exhaustive).
- Plain-text error mode: server sends `"No backend servers available."` → SDK emits `ProtocolError` with `details.rawMessage` populated. No `console.warn`.
- Rate-limit throttle: 100 `sendMessage` calls within 1 s with default `maxRequestsPerSecond=6` → at most 6 are sent per second; remainder are queued in `maxPendingOutgoing`.
- `RATE_LIMITED` received from server despite throttle: SDK retries after 200 ms backoff.

---

### 5.5 [P1 · Breaking · S · Low risk] `DisconnectReason` on `ConnectionClosed` (D11)

```ts
export enum DisconnectReason {
  ClientInitiated = "client_initiated",
  ServerInitiated = "server_initiated",
  ConnectionLost  = "connection_lost",      // heartbeat timeout, network drop
  AuthenticationFailed = "authentication_failed",
  SessionTimeout = "session_timeout",
  ReconnectFailed = "reconnect_failed",
  Unknown = "unknown",
}
```

Event signature change:
```ts
[OjinEvent.ConnectionClosed]: (info: {
  code: number;
  reason: string;
  disconnectReason: DisconnectReason;
}) => void;
```

**Migration.** v0.1 had no public consumers of the `(code, reason)` signature, so no runtime guard is needed — the object shape ships from day one as the only supported form. CHANGELOG notes the v0.1→v1.0 shape for any in-tree callers.

**Files touched.** `src/events.ts`, `src/ojin-client.ts` (`handleClose`).

---

### 5.6 [P1 · Non-breaking · S · Low risk] Configurable audio chunk size (D9)

- Option `audioChunkSize?: number` (default `500_000` bytes; min `1024`; **max `512_000` bytes = 512 KB — the server limit**).
- **Server enforces a 512 KB max message size** (flashhead-lite docs: *"Max message size: 512 KB per message"*, `FRAME_SIZE_EXCEEDED` on violation). The "message" includes our header (13 B) + params JSON, so the real payload ceiling is ~511 KB. Default of `500_000` leaves headroom for worst-case params; max `512_000` is the absolute ceiling the proxy will accept.
- (Earlier plan draft had a 2 MiB ceiling — corrected after reviewing the flashhead-lite API docs on 2026-04-20. Q7 resolved.)
- Validated in constructor — throw `OjinError(ConfigurationError)` on out-of-range.
- Server violations surface as `OjinErrorCode.FrameSizeExceeded` via the mapping in §5.4.

**Files touched.** `src/types.ts`, `src/ojin-client.ts`.

---

### 5.7 [P1 · Non-breaking · M · Low risk] Convenience methods

New instance methods, layered **on top of** `sendMessage`:

| Method | Equivalent |
|---|---|
| `sendText(text: string, params?: Record<string, unknown>)` | `sendMessage(new OjinTextInputMessage(text, params))` |
| `sendAudio(pcm: Uint8Array, params?)` | `sendMessage(new OjinAudioInputMessage(pcm, params))` |
| `interrupt()` | `sendMessage(new OjinCancelInteractionMessage())` |
| `endInteraction()` | `sendMessage(new OjinEndInteractionMessage())` |

Raw `sendMessage` and message classes remain public for advanced users and Python-parity examples.

**Files touched.** `src/ojin-client.ts`, README quickstart rewrite.

**Tests.** Assert the convenience method produces the same logical message as the raw equivalent via **structural equality excluding the `timestamp` field** — not byte-identity, since timestamps differ across calls. Use one `.omit("timestamp")` helper in tests to avoid drift.

---

## 6. v1.0 — DX & Build

### 6.1 ~~[P1 · S] UMD bundle for `<script>` tag consumers~~ — **Out-of-scope for v1.0 (2026-04-21)**

**Withdrawn.** Node-only v1.0 does not ship a `<script>`-tag bundle. Revisit only if browser support returns.

**Public-surface narrowing (still in-scope, retargeted as a hygiene concern for the Node package).** The current `src/index.ts` re-exports ~50 symbols, many of them low-level protocol internals (`serializeInteractionInputMessage`, `deserializeInteractionResponseMessage`, `bytesToUuid`, `uuidToBytes`, `NIL_UUID`, `payloadTypeFromStr`, `payloadTypeToStr`, `PayloadType`, `FPSTracker`, `LatencyTracker`, raw `MessageType` enum, and the full `SessionSetupMessage` / `SessionUpdateMessage` type aliases). Exposing these by default means every protocol refactor is a public-API break. Restructure `package.json` `exports` into subpaths:

- `@ojinai/js-sdk` — default entry: the factory, `OjinClient`, message classes, `OjinEvent` / `ConnectionState` / `DisconnectReason` enums, error classes, `OjinErrorCode` enum, `OjinLogger` interface, `OjinClientOptions` type.
- `@ojinai/js-sdk/protocol` — `serialize*` / `deserialize*` / `PayloadType` / raw `MessageType`. For advanced consumers building alternate transports.
- `@ojinai/js-sdk/profiling` — `FPSTracker`, `LatencyTracker`.
- `@ojinai/js-sdk/internal/uuid` — `bytesToUuid`, `uuidToBytes`, `NIL_UUID`. Prefixed `internal/` so consumers know it is not a stable surface.

Each subpath has its own type-declaration file.

### 6.2 [P1 · M] TypeDoc-generated API reference

- `pnpm run docs` → `docs/api/`.
- Build site in CI, publish to GitHub Pages.
- Enforce: every exported symbol has a JSDoc block with at least a one-line summary.

### 6.3 [Moved to v1.5] Example projects

Moved out of v1.0 to keep the release focused. v1.5 will ship a Node example:

- `examples/node-cli/` — streams text input, logs response frame sizes.
- Browser examples (`browser-vanilla`, `react-next`) are withdrawn — deferred with browser support itself.

### 6.4 ~~[P1 · S] Build-time version injection~~ — **Out-of-scope for v1.0 (2026-04-21)**

Node consumers can read the version from `package.json` directly if needed; no bundle-time injection required.

### 6.5 [P2 · S] Source-map validation

Add a CI step that loads each dist bundle and verifies source maps resolve to `src/` — catches preserveModules misconfigurations.

### 6.6 [P1 · S — promoted from P2] Bundle-size budget + tree-shaking verification

Track `dist/esm/index.js` gzip size in CI. Fail the PR if it grows by more than 10% above the recorded baseline without explicit override.

**Baseline is pinned during v1.0 development, not after.** Without a baseline the 10% check is meaningless. First PR of the v1.0 work records the current size.

**Tree-shaking verification (FE-review finding 15).** `preserveModules: true` in the Rollup config (§1.1) preserves the module graph, which is correct for downstream tree-shaking *only if* no module has top-level side effects. `src/utils/profiling.ts:96-99` initialises `static` `Map` fields at module load — that can defeat tree-shaking in some bundler configurations. Fix and verify:

- Move `FPSTracker` / `LatencyTracker` out of the default entry (§6.1 subpath restructure).
- Convert `LatencyTracker`'s `static` `Map` initialisers to lazy getters so they are not module-init side effects.
- Add a CI step that builds a dummy consumer importing only `OjinClient`, runs Rollup against it, and asserts the output does not contain the class names `FPSTracker`, `LatencyTracker`, or the profiling module's source text.

### 6.7 [P1 · S] Bump `engines` to `node >= 20`

`package.json` currently says `node >= 18`. Node 18 enters end-of-life on 2025-04-30. HeyGen already ships `node >= 22`; Anam still on `>= 18`. Commit to `>= 20` for v1.0 — middle of the pack, supported through April 2026, avoids shipping on dead LTS.

---

## 7. v1.5 — Session tokens & ergonomics

### 7.1 [P1 · Non-breaking · L · Med risk] Session-token auth

- `createClient(sessionToken: string, options?)` — production-safe factory.
- `unsafe_createClientWithApiKey(apiKey, configId, options?)` already shipped in 1.0 — remains supported.
- Token carried as `Authorization: Bearer <token>` on Node, `?session_token=<token>` on browser (same dual strategy as API key).
- **Token shape follows Anam's precedent:** JWT with a `type` claim ∈ {`ephemeral`, `stateful`}, standard `exp` for expiry, and account / config claims. Exact claim set finalized in §14 Q3.
- **JWT decoding** (without verification — server verifies) to extract:
  - `exp` → auto-refresh hook exposed to consumer (`options.refreshToken?: () => Promise<string>`).
  - `configId` claim (if present, must match `options.configId` or we throw a configuration error).
- **Revocation handling:** on server-issued `AuthenticationFailed`, clear the cached token and call `refreshToken` if provided; escalate to `ConnectionClosed(AuthenticationFailed)` if no refresher.

### 7.2 [P1 · M] Reference token-exchange server snippet

README section and `examples/token-exchange-server/` with:
- Express handler.
- Next.js API route.
- Documenting TTL recommendations and claim shape.

### 7.3 [Deferred past v1.5 — not committed] Client metrics / telemetry

**Not in v1 or v1.5.** If/when we ship it later:

- **Off by default.** No opt-out is a better default than opt-out; defer the default-on posture until a privacy review clears it.
- Lower priority overall — the data is useful but not worth the compliance and design overhead in early GA.
- Shape sketched previously (fire-and-forget `fetch`, single zero-dep file) is still the right direction; not committed here.

### 7.4 ~~[Moved to v2.0 · XL]~~ `streamToVideoElement(id)` / `streamToCanvas(el)` DOM helpers — **Deferred indefinitely (2026-04-21)**

DOM helpers are only relevant to a browser build. Under Node-only v1.0 and the ruling against direct browser WS consumption, these are not on any version roadmap. Revisit only when browser support returns via a real media-transport ingress (WebRTC / LiveKit / Daily) — at which point rendering is likely delivered by the transport layer (e.g. a LiveKit `Room` + `VideoTrack`) rather than by this SDK.

<details>
<summary>Historical content (deferred)</summary>

Why originally deferred to v2.0: our WS transport delivers encoded frames + PCM audio, not a native `MediaStream`. Competitors (Anam via WebRTC, HeyGen via LiveKit) hand the browser a video codec stream and get painting / sync for free; we own the decode + paint + audio-jitter-buffer path.

**Frame format confirmed: JPEG** (flashhead-lite docs, Q1 resolved). Video-side decoding is straightforward via `createImageBitmap`. The hard parts are off-main-thread rendering and lip-sync; neither is a one-liner. FE-review findings 3 and 6 pushed the effort back from L to XL — the audio jitter buffer is a multi-week problem and main-thread rendering janks on mobile. Spec is now concrete.

**Video pipeline — off-main-thread by default (FE-review finding 6).**

- `streamToCanvas(canvasEl: HTMLCanvasElement)` — on first call, invokes `canvasEl.transferControlToOffscreen()` and hands drawing to a Worker. The Worker decodes each `Blob([jpegBytes], { type: "image/jpeg" })` via `createImageBitmap` and draws via `ctx.drawImage(bitmap, 0, 0)` on the offscreen canvas.
- **Main-thread fallback** only where `transferControlToOffscreen` is unavailable (older Safari). Feature-detected at run time; **not** a runtime config flag. Documented as "best effort on Safari ≤ 16; recommended browsers are Safari 17+, Chromium 94+, Firefox 105+."
- **`ImageBitmap` ownership (FE-review finding 9).** SDK-retained; every bitmap is `.close()`d after the draw call (for `streamToCanvas`) or after `queueMicrotask` following the event handler return (for the raw `InteractionResponse` event). Consumers who need to retain a frame call `message.retainFrame(): ImageBitmap`, which transfers ownership and *removes* the SDK's `.close()` for that bitmap. Without explicit retention, consumers who hold an `InteractionResponse` past the handler see a closed `ImageBitmap` — intentional; catches the leak at the API boundary.
- **Render budget** (committed in §15.3): ≤ 8 ms main-thread cost per frame on a 2021 mid-tier Android (Pixel 6a baseline).

**Audio pipeline — `AudioContext.currentTime` as the master clock (FE-review finding 3).**

- **Master clock.** `AudioContext.currentTime` is authoritative. Every audio frame's playback is scheduled via `sourceNode.start(audioCtx.currentTime + leadMs / 1000)`. Video frame display time is slaved to audio: each `requestAnimationFrame` tick picks the video frame whose target display time is closest to the current audio playhead.
- **Jitter buffer depth.** Target `audioBufferTargetMs = 100` (industry norm for conversational avatars); configurable `minBufferMs = 60`, `maxBufferMs = 200`.
- **Underrun policy.** Emit silence + `OjinEvent.AudioUnderrun` (new event, add to Appendix A); do **not** time-stretch in v2.0. Video re-anchors on next non-silent audio.
- **iOS user-gesture gate.** `AudioContext` starts in `"suspended"` state on iOS until a user gesture. Expose `await client.unlockAudio()` that the consumer calls from a user-interaction handler (tap, click). `streamToVideoElement` / `streamToCanvas` throws a typed `AudioLockedError` (new in §5.4) if invoked before unlock — with a docs link explaining the gesture requirement.

**Render handle controls.** `pause()`, `resume()`, `setVolume(0..1)`, `unlockAudio()`, `onRenderStats({ fps, audioUnderruns, lipSyncOffsetMs, drawMs })`.

**Lip-sync acceptance criterion (committed in §15.3):** median audio-video offset ≤ 20 ms over a 60 s session, p95 ≤ 40 ms. Measured via the render stats stream.

Could become simpler in the future if we add a WebRTC transport alongside the WS one — flagged as a long-term option under §8.3.

</details>

## 8. v2.0 — Structural

### 8.1 [P2 · XL] Monorepo conversion

- `pnpm-workspace.yaml` with `packages/js-sdk` (existing `@ojinai/js-sdk` moves here), `packages/react` (new `@ojinai/react`), `examples/*`.
- Turborepo for caching; mirrors HeyGen layout.
- Shared `tsconfig.base.json` and `biome.json`.
- Publishing via `changesets` (simpler than semantic-release for monorepos).

### 8.2 [P2 · L] `@ojinai/react` hooks package

Hooks-package design must survive React 18 Strict Mode's mount-unmount-remount cycle and Suspense boundaries. FE-review finding 7 flagged the original three-line sketch as inadequate; spec expanded here.

**Prerequisites from v1.0:**
- `OjinClient.connect()` / `close()` must be re-entrant. Internal `AbortController` tied to `close()` aborts the in-flight retry loop (§5.1) and guarantees transport teardown before returning. Unmount during `Connecting` no longer leaves a ghost socket.
- `events.on()` returns an unsubscribe function (FE-review finding 10; see §5.5 event section and Appendix A). Inline arrow handlers — common in React — are first-class citizens without manual `useCallback`.

**Hooks.**

- `useOjinClient(options)` — constructs the client exactly once via `useRef`; connects on mount; `close()` in effect cleanup. The cleanup **awaits** `close()`'s promise before resolving, so the next Strict-Mode remount sees a fully-torn-down state before its `connect()` fires. Returns `{ client, connectionState, lastError }`.
- `useOjinStream(client, target)` — paints frames to a target. `target` is a **stable string id** (`videoId`) rather than a ref, to avoid Suspense-boundary race conditions where the ref identity changes between render and effect. If a ref must be supported, document that the consumer owns ref stability.
- `useOjinMessages(client)` — returns an accumulating message log using a reducer; bounded (default last 100 messages).

**Strict Mode tests.** Every hook must pass its test harness wrapped in `<React.StrictMode>`. Specifically:
- Mount + unmount + remount within 10 ms — no duplicate socket, no leaked listener.
- Mount during `SessionReady` delay of 2 s + unmount at 1 s + remount at 1.5 s — final client is cleanly connected, no two sockets.
- Suspense boundary: component using `useOjinClient` suspends on an unrelated promise — no resource leak while suspended.

### 8.3 [P3 · L] Separate transport for WebTransport

When browser WebTransport support matures, add an alternate transport behind the same `WSTransport` interface — already abstracted in 1.0.

---

## 9. Testing Strategy

### 9.1 Test pyramid

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Protocol serializers (round-trip), emitter, logger, error mapping, redaction, URL builder, backoff math. |
| Integration (Node) | Vitest + real `ws` server (already present) | connect, send, receive, chunking, close, reconnect, heartbeat timeout, queue overflow. |
| Integration (browser) | Vitest + `happy-dom` + mock `WebSocket` | URL-based auth, no header path, JSON-only heartbeat, `Blob`/`ArrayBuffer` handling. |
| Real-browser smoke (v1.0 — **promoted from post-v1.0 after FE review finding 4**) | Playwright against Chromium, Firefox, WebKit | One test: `connect` → `SessionReady` → `sendText` → one `InteractionResponse` → clean disconnect. Plus one BFCache test (WebKit only): navigate away, browser-back, assert reconnect fires. Runs against the same mock WS server as the happy-dom suite; no staging dependency. **Gates the v1.0 tag** (§15.1). |
| Type tests | **`vitest` + `expectTypeOf`** (committed) — no new dep | Client vs server message constraint, event callback arity, options nullability, `LoggableMeta` scalar-only. |
| E2E | Playwright (v1.5) | Browser-vanilla example renders a frame end-to-end against a staging backend. |
| Performance | Vitest bench | Serializer throughput; emitter dispatch cost with 100 listeners; logger hot-path cost with level-filtered; redaction with 20 top-level keys. |

### 9.2 Coverage targets

- Retain 80% across all metrics (existing `vitest.config.ts`).
- Raise `branches` to 85% before 1.0 ships; critical paths (connect, reconnect, handleMessage, auth) must be 100%.

### 9.3 Property tests

Library: **`fast-check`** (committed).

- Byte-level serializers: fuzz `payloadType × params × payload size` — invariant: `deserialize(serialize(x)) === x`.
- URL builder: random configIds and apiKeys with URL-reserved characters — invariant: server parses back the same values.

### 9.4 Negative-path tests

Must have explicit tests for:

- Malformed JSON server message (binary flag mismatch, truncated payload).
- Server sends `sessionReady` twice.
- Server sends `errorResponse` before `sessionReady`.
- Client calls `connect()` twice concurrently.
- Client calls `close()` during `Connecting` — AbortController aborts the in-flight retry loop; no ghost socket remains (FE-review finding 7).
- Client calls `close()` during the reconnect backoff sleep — sleep rejects via the shared abort (FE-review finding 18).
- Client calls `sendMessage` after `close()`.
- WebSocket closes during `sendMessage` mid-chunk.
- Reconnect with pending queued messages — messages are flushed in order.
- `maxReconnectAttempts` counter resets to zero after a successful reconnect (FE-review finding 18).
- Auth failure (ErrorResponse code on the no-retry list — §5.1) — no retry attempted; `ConnectionClosed(AuthenticationFailed)` emitted.
- Network drops mid-audio-stream — all chunks of an interaction either arrive or the client reports a clear error.
- **Background-tab simulation (FE-review finding 1):** `vi.useFakeTimers()` + `Date.now()` jump of 90 s while "hidden"; synthetic `visibilitychange → visible` event; reconnect begins synchronously on foregrounding.
- **BFCache (finding 2):** Playwright on WebKit — navigate away, browser back; assert the SDK closed on `pagehide.persisted === true` and reconnected on `pageshow.persisted === true`.
- **Legacy option-name guards (finding 16):** constructor called with `reconnectDelay: 5` throws `ConfigurationError` carrying the migration message. Same for `reconnectAttempts` and `maxQueuedMessages` / `maxPendingOutgoing` (the flat renames).
- **Node `Buffer` interop (FE-review finding 21):** construct `OjinAudioInputMessage` from a `Buffer.from(pool, offset, length)` backed by Node's shared pool; send; assert the mock server receives the intended byte slice, not pool backing bytes.
- **Node ping-interval cleanup (finding 17):** `connect()` + `close()` leaves `process._getActiveHandles()` unchanged.
- **Outgoing queue overflow rejects (finding 11):** with `outgoingQueue.onOverflow: "reject"` (default), over-capacity `sendMessage` rejects with `QueueFullError`.

### 9.5 Regression fixtures

Commit a directory of binary fixtures (`tests/fixtures/wire/`) captured from the Python SDK so we guarantee Python ↔ TS wire compatibility.

---

## 10. Documentation Plan

### 10.1 README rewrite (v1.0)

Structure:

1. One-paragraph positioning — **Node/server SDK**. Explicit "not for browser use" line up top.
2. Install (`npm install @ojinai/js-sdk`, Node ≥ 20).
3. Quickstart — Node server example: construct the client with an API key, listen for events, forward frames to the app's own client transport.
4. **"Not for client-side use" callout** — API keys must stay on the server; do not bundle the SDK into a browser. Future browser support deferred until the backend ships a media-transport ingress.
5. API reference pointer (TypeDoc site).
6. Events table.
7. Error codes table.
8. Migration notes (v0.1 → v1.0, including the browser-path removal).
9. License.

### 10.2 Docs site

- TypeDoc → GitHub Pages or docs subdomain.
- One-page "concepts" page: session, interaction, frame types, idle vs speech.
- Recipes: Node-side audio ingestion (file / stream), forwarding frames to a downstream client transport, handling interruption from a control channel. (Browser-capture / canvas-paint recipes removed — they assumed direct client-side use.)

### 10.3 CHANGELOG

- Keep-a-changelog format.
- Breaking changes under their own section per release.
- v1.0 release notes enumerate every D-item from §1.2 that was fixed.

### 10.4 Security policy

`SECURITY.md`:
- No API key in source; environment variable only.
- Session tokens (post-1.5) must not be stored in `localStorage`; suggest in-memory or short-lived cookie.
- How to report vulnerabilities.

### 10.5 Contributing guide

`CONTRIBUTING.md`:
- Commit message convention (conventional commits; prerequisite for §6 release automation).
- Branch/PR flow.
- Test requirements per change type.

### 10.6 ~~Deployment recipes — CSP, Permissions-Policy, COEP~~ — **Out-of-scope for v1.0 (2026-04-21)**

Withdrawn. These recipes apply to browser deployments; Node-only v1.0 has no CSP / Permissions-Policy / COEP surface to document. Revisit alongside browser support.

---

## 11. Backwards Compatibility & Migration

### 11.1 v0.1 → v1.0 breaking changes

| Change | Impact | Mitigation |
|---|---|---|
| `sendMessage` now typed as `OjinClientMessage` | Consumers passing server messages get compile error — but that code never worked at runtime. | TypeScript migration comment in CHANGELOG. |
| `ConnectionClosed` event delivers an object `{ code, reason, disconnectReason }` and is named `session.closed` (dotted namespace from day one) | v0.1 had no public consumers to migrate | None needed; CHANGELOG documents the shape for in-tree callers. |
| `Uint8Array<ArrayBuffer>` → `Uint8Array` | Type-level only; runtime unchanged | None needed. |
| `toProxyMessage()` renamed `toMessage()` on client messages; removed from server messages where it threw | Private-ish API; behaviour preserved on client side | CHANGELOG row; compile error surfaces any accidental call on a server message. |
| `reconnectAttempts` → `initialConnectAttempts` / `maxReconnectAttempts` | Field rename + split | CHANGELOG row; no alias because the original name was ambiguous between initial-connect and live-drop semantics. |
| `reconnectDelay` (seconds) → `reconnectBackoff.initialMs` / `initialConnectDelayMs` (ms) | Field rename and unit change (s → ms) | **Runtime guard (FE-review finding 16):** constructor throws `ConfigurationError` if the old option is defined, with message *"`reconnectDelay` was removed in v1.0. Use `reconnectBackoff.initialMs` (milliseconds, not seconds). See the migration guide."* Loud failure, not silent. Guard kept for one minor (v1.0 → v1.1), then removed. |
| `OjinErrorCode.UnknownMessage` removed; 11 server-originated codes added (`AuthFailed`, `Unauthorized`, `MissingConfigId`, `InvalidMessage`, `InvalidHeaders`, `ModelNotFound`, `BackendUnavailable`, `RateLimited`, `Cancelled`, `InternalError`, `FrameSizeExceeded`) plus `QueueFull` | Enum shape changes | Catch-blocks on removed member become dead; any consumer previously matching `UnknownMessage` now sees `ProtocolError`. CHANGELOG carries the full before/after table. |
| `maxPendingOutgoing` (flat) → nested `outgoingQueue.maxMessages` + `outgoingQueue.onOverflow` | Option shape change (FE-review finding 12) | Runtime guard: constructor throws `ConfigurationError` naming the flat name and its nested replacement. Outgoing default flips from drop-oldest to reject (finding 11). |
| `autoWaitForReady` default flipped from `true` to `false` (FE-review finding 5) | Behavioural change | CHANGELOG flags it as breaking; consumers who relied on implicit buffering opt back in with `autoWaitForReady: true`. New `WaitingForReady` event and `ReadyTimeoutError` for those who do. |
| `events.on()` now returns an unsubscribe function; new `events.once()` method (FE-review finding 10) | API addition, not removal | Old `events.off(event, cb)` continues to work. New idiomatic React integration uses the returned unsubscribe. |
| `receiveMessage()` and `startInteraction()` removed outright | Methods no longer exist; typed compile error at every call site | No runtime flag, no deprecation — events are the only delivery path (§4.3). |

### 11.2 Deprecations (v1.0 keeps working, v2.0 removes)

None. v1.0 ships no deprecated surface — `receiveMessage()` / `startInteraction()` are deleted outright (§4.3), and dotted event names ship natively (no flat aliases to deprecate).

### 11.3 Wire-protocol compatibility

No wire changes in v1.0 or v1.5. If v2.0 adds new message types, they must be ignored cleanly by older SDKs (`Unknown message type:` path already exists at `src/ojin-client.ts:257`).

---

## 12. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Backend doesn't support `api_key` query param | Low | High | Backend confirmation before merge (§14 Q2); fallback to subprotocol. |
| R2 | JWT decoding adds bundle weight | Low | Low | Hand-rolled base64 decode (no `jsonwebtoken` dep); matches Anam approach. |
| R3 | Reconnect masks server-side problems that should fail fast | Med | Med | Auth errors never retry; expose `events.Reconnecting` so UIs can show status. |
| R4 | Deprecation warnings break apps that run in strict-mode linters | Low | Low | Warnings go through logger (silenceable); not thrown. |
| R5 | Convenience methods diverge from raw `sendMessage` | Low | Med | Tests assert convenience method produces a structurally equal message (modulo `timestamp`) — see §5.7. |
| R5b | Logger + redaction overhead on hot frame path (every `handleMessage` through the pipeline) | Low | Med | FE-review findings 13, 14. `logger.isLevelEnabled()` short-circuit at every call site; key-whitelist (top-level) redaction only; `LoggableMeta` forbids nested objects at the type level; benches in §9.1. |
| R6 | Browser heartbeat JSON frames add cost at scale | Low | Low | 30 s interval, ~30 bytes each, negligible. |
| R7 | Session-token factory (v1.5) ships while backend is still validating | Med | High | Launch behind a feature flag / beta tag; require backend sign-off on token format. |
| R8 | Deleting `receiveMessage` in v1.0 breaks internal Python-parity users who relied on the polling API | Low | Low | Survey internal users before the v1.0 tag; in-tree callers migrate to `events.on(OjinEvent.InteractionResponse, …)`. No external consumers at v0.1. |
| R9 | Monorepo conversion (v2.0) churns import paths for external consumers | Med | Med | v1.0 publishes under `@ojinai/js-sdk` already, so the monorepo move keeps the same published name — no import-path churn for consumers. Internal path moves only. |
| R10 | Mid-project wire-protocol change by backend or Python SDK | Low | High | Wire-compat fixtures captured from Python (§9.5) caught in CI; coordination channel with Python / backend teams. |
| R11 | Safari BFCache (back/forward cache) silently suspends the WebSocket; no `close` event until `pageshow`. Reconnect logic can fight BFCache. | Med | Med | **Promoted from one-line mitigation to full §5.2 subsection (FE-review finding 2):** `pagehide.persisted === true` → proactive `close()` + `Disconnected`; `pageshow.persisted === true` → unconditional reconnect. Playwright test on WebKit gates v1.0 (§15.1). |
| R12 | *(merged into R5b above)* | — | — | See R5b. |
| R13 | happy-dom does not faithfully reproduce real-browser `WebSocket` / `Blob` edge cases; CI tests pass but Safari/Firefox break. | Med | Med | **Promoted to v1.0 mitigation (FE-review finding 4):** one Playwright smoke test across Chromium / Firefox / WebKit against the same mock WS server, gating the v1.0 tag (§15.1). Broader e2e coverage in v1.5. |
| R14 | `setTimeout`-derived idle check unreliable under tab throttling / iOS Safari timer freeze | **High** | **High** | FE-review finding 1. §5.2 redesigned to anchor on `Date.now()` wall-clock + event-driven checks (`visibilitychange`, `pageshow`, `focus`, `online`); long-running `setTimeout` is a belt-and-braces watchdog, not the authority. Background-tab negative-path test in §9.4. |
| R15 | Main-thread JPEG decode + paint at 25 fps janks on mid-tier mobile | Med | High | FE-review finding 6. v2.0 `streamToCanvas` uses `transferControlToOffscreen` + Worker by default; main-thread fallback only where feature unavailable; render budget ≤ 8 ms/frame on Pixel 6a committed in §15.3. |
| R16 | `ImageBitmap` lifetime leaks GPU memory on long sessions | Med | High | FE-review finding 9. SDK owns bitmap lifetime; `.close()` after draw or post-`queueMicrotask` in event handlers; `message.retainFrame()` for explicit consumer retention; soak test extended to 60 min with heap-growth budget. |

---

## 13. Defensive Review Checklist

Anticipated objections from the external reviewer, pre-answered.

1. **"Why not session tokens in v1.0?"** Decision recorded by the team; requires backend token-exchange endpoint not yet finalized. Matches Anam's own history (they shipped `unsafe_createClientWithApiKey` first).
2. **"Why delete `receiveMessage` outright instead of deprecating?"** v0.1 has no external consumers; the polling API is a Python-asyncio carry-over with no TS/JS precedent. Keeping it means shipping two delivery paths forever (events + poll) and a permanent "which do I use?" docs burden. Cleaner to start with one canonical surface.
3. **"AsyncIterator?"** Not planned. Events are the canonical API; adding `for await (const msg of client.messages())` later is additive and non-breaking if a real need emerges.
4. **"Is the query-param auth really safe enough for dev?"** No — which is why the factory is literally named `unsafe_`. Same posture as Anam. Production path ships in 1.5.
5. **"Exponential backoff with jitter — what if the server is fine but a burst of clients reconnects?"** Jitter factor 0.3 on a base of 500 ms → 30 s cap. Spread is sufficient for typical burst sizes; server-side rate limiting complements it.
6. **"Why not WebTransport?"** Non-goal — shipping browser WS today reaches 100% of targets. WebTransport plumbing is reserved behind the `WSTransport` abstraction (§8.3).
7. **"How do you prevent the SDK from eating errors?"** Audit — every `catch` block in the new code must either: rethrow, log to the injected logger at `error` level, or emit `OjinEvent.Error`. A lint rule / review checklist enforces this.
8. **"What happens if the browser tab goes to background?"** Design is explicitly wall-clock anchored (§5.2, FE-review finding 1). Every inbound frame updates `lastInboundAtMs = Date.now()` — `Date.now()` advances across tab suspension; `setTimeout` is only a belt-and-braces watchdog. On `visibilitychange → visible` (and on `pageshow`, `focus`, `online`) the client synchronously runs `Date.now() - lastInboundAtMs > inboundIdleTimeoutMs` and, if stale, enters reconnect without waiting for a throttled timer. Background-tab negative-path test covers the case.
9. **"React 18 Strict Mode double-invokes effects — does that leak sockets?"** FE-review finding 7 pushed back on the original one-line answer. Real spec: `connect()` runs its retry loop under an AbortController held on the instance; `close()` aborts the controller so an unmount during `Connecting` terminates in-flight attempts before the effect cleanup returns. `useOjinClient` in §8.2 awaits `close()`'s promise in the effect cleanup, so the next Strict-Mode remount sees a fully-torn-down state. Tests cover (a) mount+unmount+remount within 10 ms, (b) unmount at 1 s during a 2 s `SessionReady` delay then remount at 1.5 s, (c) Suspense suspension while holding the hook. All wrapped in `<React.StrictMode>`.
10. **"Memory leaks?"** Explicit listener + timer audit, not a claim. All `addEventListener` paired with a corresponding `removeEventListener` tracked in a per-instance cleanup array; the `setTimeout` watchdog + `setInterval` heartbeat (Node) + backoff sleeps all run on the instance's AbortController, cleared in `close()` before the transport is nulled (FE-review finding 17). Node intervals use `.unref()` so they never block process exit. `responseResolvers` resolved with `null` on close. `ImageBitmap` lifetimes owned by the SDK with explicit `.close()` after draw or `queueMicrotask` (finding 9); consumers opt into retention via `message.retainFrame()`. Enforcement: a grep-in-CI rule fails the build on raw `console.*` or `setInterval`/`setTimeout` outside the abort-aware wrappers.
11. **"Security — can an attacker replay the API key by sniffing the URL?"** URL is over TLS. Browser devtools/history exposure is the real risk — documented, and the `unsafe_` naming + 1.5 session tokens are the answer.
12. **"Testing — can you prove browser behaviour in CI?"** Yes: Vitest + happy-dom + mock `WebSocket` covers the browser code path without a real browser; Playwright e2e is a v1.5 follow-up.
13. **"Dependency surface?"** Runtime deps remain {`ws`}. Nothing added for v1.0. v1.5 adds zero new runtime deps (hand-rolled JWT decode). Telemetry is deferred past v1.5.
14. **"What guarantees do you give on frame ordering?"** Server emits `index` — SDK passes it through; SDK does not re-order or merge. Documented in the concepts page.

---

## 14. Open Questions / Needs Decision

**Resolved during review (retained here for audit trail):**

- **Q1 — Frame format → JPEG.** Confirmed via flashhead-lite API docs on 2026-04-20. 25 fps, 1280×720 example resolution, binary payload type `2`. Feeds §7.4.
- **Q7 — Max frame size → 512 KB.** Same doc source, verbatim: *"Max message size: 512 KB per message"*, error `FRAME_SIZE_EXCEEDED`. Drove §5.6 correction.
- **Q9 — Session outlives `exp`? → No, evict on expiry.** Decided during review; feeds §7.1 `refreshToken` design.
- **Q10 — React Native tier → v2.1**, not v2.0. Product decision.
- **Q11 — Package name → `@ojinai/js-sdk`** under npm scope `@ojinai` (matches `github.com/ojinai`). Repo `ojinai/js-sdk`. "Client" was narrower than warranted; SDK matches industry norm (Anam `@anam-ai/js-sdk`, HeyGen `@heygen/liveavatar-web-sdk`).
- **Q12 — Dist-tag → ship v1.5 directly to `latest`**, no beta, no users to protect yet.
- **Telemetry scope** — not in v1.0 or v1.5; deferred to v2.0+ and off-by-default when shipped. (Former Q4 retired.)

**Still open:**

| # | Question | Owner | Needed by |
|---|---|---|---|
| Q2 | Does the proxy/backend accept `?api_key=` query parameter in the WS upgrade? Python SDK confirms header auth today; browsers cannot set headers. If query param not supported, either (a) backend change, or (b) rely on v1.5 session tokens for browser use. | Backend team | **before 1.0 browser works — blocker for browser support** |
| Q3 | Expected TTL and claim shape for session tokens (1.5). Starting template: Anam-style JWT (`type` ∈ `ephemeral` \| `stateful`, `exp`, account / config claims). Plan proposal: 15 min ephemeral / 4 h stateful. | Auth / backend team | start of 1.5 |
| Q5 | Should `mode` support values beyond `"dev"`? Plan proposal: keep binary `"dev" \| null`; use `wsUrl` for environment routing. | Product | 1.0 nice-to-have |
| Q6 | WS close codes (the numeric 1xxx / 4xxx close-frame codes): what does the proxy emit on server-initiated closes with no preceding `ErrorResponse`? Application-level error codes resolved via the flashhead-lite docs (12 documented codes — §5.4); Q6 now only covers residual "bare close with no error" cases. | Backend team | **nice to have — no longer a blocker**; SDK defaults to retry on bare close. |
| Q8 | Does the proxy emit an app-level `sessionPing` JSON frame, and at what cadence? The handler exists in code but docs don't document cadence. Our passive-liveness default (`inboundIdleTimeoutMs = 45_000`) assumes ≤ ~30 s. | Backend team | before 1.0 PR merge |

---

## 15. Acceptance Criteria

### 15.1 v1.0 GA

- [ ] All P0 defects (§1.2 D2, D3; D1 superseded) closed with tests.
- [ ] All P1 items shipped.
- [ ] Coverage ≥ 80% overall, ≥ 85% branches, 100% on connect/reconnect/handleClose/auth paths.
- [ ] Dual ESM + CJS builds produced and tested against Node 20 and 22.
- [ ] **Node-only constraint enforced:** no `window` / `document` / `navigator` / `WebSocket` (global) references in `src/`; `package.json` has no `browser` field and no UMD/IIFE output; `resolve({ browser: true })` removed from `rollup.config.mjs`. (Grep-in-CI rule.)
- [ ] **Public-surface narrowing verified:** `@ojinai/js-sdk` default entry exports the minimal surface; protocol / profiling / internal subpaths in `package.json` `exports`.
- [ ] **No raw `console.*` or unowned `setInterval`/`setTimeout` in `src/`** (grep-in-CI rule, FE-review finding 25).
- [ ] README quickstart runs end-to-end against a staging backend **from a Node process**; README prominently states the SDK is not for client-side use.
- [ ] TypeDoc site publishes in CI.
- [ ] 10-minute soak test at simulated stream rate runs without unbounded RSS growth (numeric target set in v1.5 after baseline measurement).
- [ ] Wire-compat fixture tests pass against Python SDK-captured binary frames.
- [ ] `pnpm lint:check`, `pnpm typecheck`, `pnpm test:cov` all green in CI.
- [ ] CHANGELOG entry listing every fix with D-number reference, migration-guide pointers for the renamed options (§11.1), **and a prominent "v0.1 → v1.0: browser path removed" entry** with rationale.
- [ ] SECURITY.md and CONTRIBUTING.md in place.

~~_Removed 2026-04-21 (browser-specific):_~~
- ~~Browser smoke test (happy-dom + mock `WebSocket`).~~
- ~~Playwright smoke test on Chromium / Firefox / WebKit.~~
- ~~BFCache negative-path test on Playwright/WebKit.~~
- ~~Background-tab simulation test.~~
- ~~UMD build produced and loaded in a headless-browser CI step.~~
- ~~Tree-shaking test excluding profiling from the default entry.~~
- ~~Baseline ESM gzip size + bundle-size budget (§6.6).~~
- ~~README CSP / Permissions-Policy recipe (§10.6).~~

### 15.2 v1.5

- [ ] `createClient(sessionToken)` works against live backend (Node-side).
- [ ] Token expiry + refresh hook.
- [ ] Example token-exchange server (Express + Next.js).
- [ ] Example project shipped: `examples/node-cli` with a runnable quickstart.
- [ ] Measurable performance targets committed (first-frame latency, reconnect recovery, soak-test RSS budget, serializer throughput) — numbers ratified from v1.0 baselines.
- [ ] No regressions against v1.0 acceptance tests.

### 15.3 ~~v2.0~~ — **Placeholder (scope TBD)**

Under the 2026-04-21 scope change, v2.0 is re-planned only once the Ojin backend ships a media-transport ingress (WebRTC / LiveKit / Daily). The prior criteria (monorepo + React hooks + browser DOM helpers + lip-sync + render budget) assumed a browser SDK that no longer exists on the roadmap; they are not committed until that transport surface arrives.

---

## 16. Sequencing & Work Breakdown

Dependencies between work items (`->` = blocks):

```
D1 (auth fix)   -> factory exports -> README rewrite
D2 (split msg)  -> convenience methods (§5.7)
D3 (events)     -> D4 (queue bound)
D6 (waitReady)  -> D4 (reconnect)      [reconnect re-awaits ready]
D8 (logger)     -> all other logging-touching tasks
D13 (err codes) -> D11 (disconnect reason)
```

Suggested implementation waves (each = 1 focused PR):

1. **PR#1 — types & protocol (D2, D7)**: message hierarchy split + type cleanup. No runtime behaviour change.
2. **PR#2 — logger + error codes (D8, D13, D15, D17)**: plumbing for everything else. Emitter takes logger reference (FE #25); `LoggableMeta` type + key-whitelist redaction (FE #14); `isLevelEnabled` short-circuit (FE #13); grep-in-CI forbids raw `console.*`.
3. **PR#3 — auth fix + factories (D1, D19)**: URL builder, `unsafe_createClientWithApiKey`, redaction, once-per-realm warn through logger.
4. **PR#4 — ready-state (D6, D3, D12)**: `waitForReady` with AbortController, pre-ready buffer, `outgoingQueue` shape, `autoWaitForReady: false` default, `WaitingForReady` event, `ReadyTimeoutError`, `QueueFullError`. Delete `receiveMessage()` and `startInteraction()` outright along with their bookkeeping.
5. **PR#5 — reconnect + liveness (D4, D5, D11)**: backoff with abort cancellation + attempt-reset; wall-clock anchored §5.2 design with `visibilitychange` / `pageshow` / `pagehide` / `focus` / `online` hooks; Node ping `.unref()`; BFCache branch; `DisconnectReason`; new states/events.
6. **PR#6 — convenience methods + chunk config + rate limit (D9, §5.7, §5.4 throttle)**: ergonomic surface, `maxRequestsPerSecond` default 6 (resets on `ConnectionOpened`).
7. **PR#7 — API surface + emitter ergonomics (D18, FE #10, #23, #26)**: `events.on()` returns unsubscribe, `events.once()`, drop `OjinSessionReadyPing` from public exports, `package.json` `exports` subpaths, `FPSTracker` / `LatencyTracker` moved, tree-shaking verification CI step.
8. **PR#8 — build & docs (§6)**: UMD bundle + dev-vs-prod, TypeDoc site, version injection, `engines` bump to Node 20, CSP recipe in README (§10.6), baseline gzip pinned.
9. **PR#9 — v1.0 test gate (FE #1, #2, #4)**: Playwright on Chromium/Firefox/WebKit gating the tag, BFCache WebKit test, background-tab simulation, migration-guard negative-path tests.
10. **PR#10 — release prep**: CHANGELOG with D-numbers + FE-finding references, migration guide (renamed options, codemod recipe for `ConnectionClosed` signature), SECURITY/CONTRIBUTING, bump to 1.0.0-rc.

Each PR is independently reviewable and ships green CI before the next starts.

---

## Appendix A — Proposed Final Public Surface (v1.0)

```ts
// ─── Message hierarchy (new in v1.0) ─────────────────────────────────────────

export abstract class OjinMessage {}

export abstract class OjinClientMessage extends OjinMessage {
  /** Logical proxy-message representation, useful for debugging / logging. */
  abstract toMessage(): unknown;
  /** Serialized wire form: binary (Uint8Array) for text/audio, JSON string for cancel/end. */
  abstract toBytes(): string | Uint8Array;
}

export abstract class OjinServerMessage extends OjinMessage {}

// Concrete subclasses (unchanged instances, re-parented):
//   OjinTextInputMessage, OjinAudioInputMessage,
//   OjinCancelInteractionMessage, OjinEndInteractionMessage   extends OjinClientMessage
//   OjinSessionReadyMessage, OjinInteractionResponseMessage,
//   OjinErrorResponseMessage                                  extends OjinServerMessage
//
// OjinSessionReadyPing removed from public exports (FE-review finding 23) — the proxy
// sessionPing is consumed internally by the liveness path (§5.2) and never surfaced
// to consumers; keeping a public class that nothing constructs was dead surface.

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Development-only factory. Exposes the API key to the client.
 * Prefer session tokens (v1.5) for production use.
 *
 * This is the supported construction path. The `OjinClient` constructor is
 * marked `@internal` in JSDoc and stripped from TypeDoc output (FE-review
 * finding 19) — consumers are expected to go through a factory so the
 * `unsafe_` naming is visible at every call site.
 */
export function unsafe_createClientWithApiKey(
  apiKey: string,
  configId: string,
  options: Omit<OjinClientOptions, "apiKey" | "configId">,   // wsUrl is required
): OjinClient;

// ─── Client ──────────────────────────────────────────────────────────────────

export class OjinClient {
  /** @internal — prefer {@link unsafe_createClientWithApiKey} or (v1.5) `createClient`. */
  constructor(options: OjinClientOptions);

  // Lifecycle
  connect(): Promise<void>;
  close(): Promise<void>;
  waitForReady(timeoutMs?: number): Promise<OjinSessionReadyMessage>;

  // State
  readonly connectionState: ConnectionState;
  readonly isServerReady: boolean;
  isConnected(): boolean;

  // Events
  readonly events: OjinEventEmitter;

  // Convenience senders
  sendText(text: string, params?: Record<string, unknown>): Promise<void>;
  sendAudio(pcm: Uint8Array, params?: Record<string, unknown>): Promise<void>;
  interrupt(): Promise<void>;
  endInteraction(): Promise<void>;

  // Raw (advanced)
  sendMessage(message: OjinClientMessage): Promise<void>;
}

// `receiveMessage()` and `startInteraction()` are NOT part of the v1.0 surface — the Python-parity
// polling API was deleted outright (§4.3). Events are the sole delivery path.

// ─── Events ──────────────────────────────────────────────────────────────────

export enum OjinEvent {
  ConnectionStateChanged = "session.state_changed",
  ConnectionOpened       = "connection.opened",
  ConnectionClosed       = "session.closed",
  Reconnecting           = "connection.reconnecting",
  Reconnected            = "connection.reconnected",
  SessionReady           = "session.ready",
  WaitingForReady        = "session.waiting_for_ready",     // FE-review finding 5
  InteractionResponse    = "interaction.response",
  Error                  = "interaction.error",
  QueueOverflow          = "queue.overflow",                // outgoing drop-oldest / drop-newest paths
  AudioUnderrun          = "audio.underrun",                // v2.0 DOM helpers, §7.4 (FE-review finding 3)
}

export interface OjinEventCallbacks {
  [OjinEvent.ConnectionStateChanged]: (state: ConnectionState) => void;
  [OjinEvent.ConnectionOpened]:       () => void;
  [OjinEvent.ConnectionClosed]:       (info: {
    code: number;
    reason: string;
    disconnectReason: DisconnectReason;
  }) => void;
  [OjinEvent.Reconnecting]:           (info: { attempt: number; delayMs: number }) => void;
  [OjinEvent.Reconnected]:            () => void;
  [OjinEvent.SessionReady]:           (message: OjinSessionReadyMessage) => void;
  [OjinEvent.WaitingForReady]:        (info: { configId: string; elapsedMs: number }) => void;
  [OjinEvent.InteractionResponse]:    (message: OjinInteractionResponseMessage) => void;
  [OjinEvent.Error]:                  (message: OjinErrorResponseMessage) => void;
  [OjinEvent.QueueOverflow]:          (info: { dropped: number }) => void;
  [OjinEvent.AudioUnderrun]:          (info: { bufferDepthMs: number; lastAudioAt: number }) => void;
}

export class OjinEventEmitter {
  /** Register a listener. Returns an unsubscribe function (FE-review finding 10). */
  on<K extends OjinEvent>(event: K, cb: OjinEventCallbacks[K]): () => void;

  /** Register a listener that fires once, then auto-unsubscribes. Also returns
   *  an unsubscribe function for early cancellation. */
  once<K extends OjinEvent>(event: K, cb: OjinEventCallbacks[K]): () => void;

  /** Back-compat removal by callback identity. Prefer the return value of `on()`. */
  off<K extends OjinEvent>(event: K, cb: OjinEventCallbacks[K]): void;

  removeAllListeners(event?: OjinEvent): void;
}

// ─── State ───────────────────────────────────────────────────────────────────

export enum ConnectionState {
  Disconnected  = "disconnected",
  Connecting    = "connecting",
  Connected     = "connected",
  Reconnecting  = "reconnecting",
  Disconnecting = "disconnecting",
}

export enum DisconnectReason {
  ClientInitiated      = "client_initiated",
  ServerInitiated      = "server_initiated",
  ConnectionLost       = "connection_lost",        // heartbeat / idle timeout, network drop
  AuthenticationFailed = "authentication_failed",
  SessionTimeout       = "session_timeout",
  ReconnectFailed      = "reconnect_failed",
  Unknown              = "unknown",
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class OjinError extends Error {
  readonly code: OjinErrorCode;
  readonly details?: unknown;
}

// Transport / local
export class ConnectionError         extends OjinError {}
export class ProtocolError           extends OjinError {}
export class ConfigurationError      extends OjinError {}
export class TimeoutError            extends OjinError {}   // covers local + server-originated TIMEOUT
export class ReadyTimeoutError       extends OjinError {}   // waitForReady deadline; see §4.5
export class QueueFullError          extends OjinError {}   // outgoing queue rejects (FE-review finding 11)
export class AudioLockedError        extends OjinError {}   // v2.0: streamTo* before unlockAudio() on iOS

// Server-originated categories
export class AuthError               extends OjinError {}   // AUTH_FAILED, UNAUTHORIZED, INVALID_HEADERS
export class RateLimitError          extends OjinError {}   // RATE_LIMITED
export class BackendUnavailableError extends OjinError {}   // BACKEND_UNAVAILABLE

// Remaining server codes (ModelNotFound, InternalError, FrameSizeExceeded, etc.)
// surface as the base OjinError with .code set — no dedicated class.

export enum OjinErrorCode {
  // Local (SDK-originated)
  ConnectionFailed   = "CONNECTION_FAILED",
  NotConnected       = "NOT_CONNECTED",
  ServerNotReady     = "SERVER_NOT_READY",
  ProtocolError      = "PROTOCOL_ERROR",
  ConfigurationError = "CONFIGURATION_ERROR",
  ReconnectFailed    = "RECONNECT_FAILED",
  ReadyTimeout       = "READY_TIMEOUT",        // §4.5 waitForReady deadline (FE-review finding 5)
  QueueFull          = "QUEUE_FULL",           // §4.4 outgoing overflow reject (FE-review finding 11)
  AudioLocked        = "AUDIO_LOCKED",         // v2.0 streamTo* before unlockAudio() (FE-review finding 3)

  // Dual: SDK-local OR server-originated (strings match server wire code)
  Timeout            = "TIMEOUT",

  // Server-originated (1:1 with flashhead-lite docs)
  AuthFailed         = "AUTH_FAILED",
  Unauthorized       = "UNAUTHORIZED",
  MissingConfigId    = "MISSING_CONFIG_ID",
  InvalidMessage     = "INVALID_MESSAGE",
  InvalidHeaders     = "INVALID_HEADERS",
  ModelNotFound      = "MODEL_NOT_FOUND",
  BackendUnavailable = "BACKEND_UNAVAILABLE",
  RateLimited        = "RATE_LIMITED",
  Cancelled          = "CANCELLED",        // consumed silently — not emitted as OjinEvent.Error
  InternalError      = "INTERNAL_ERROR",
  FrameSizeExceeded  = "FRAME_SIZE_EXCEEDED",
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface OjinLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string,  meta?: Record<string, unknown>): void;
  warn(msg: string,  meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface OjinClientOptions {
  // Connection
  wsUrl: string;
  apiKey: string;
  configId: string;
  mode?: "dev" | null;                         // §14 Q5

  // Initial connect
  initialConnectAttempts?: number;             // default 3   (was: reconnectAttempts)
  initialConnectDelayMs?: number;              // default 500

  // Auto-reconnect on live drop
  autoReconnect?: boolean;                     // default true
  maxReconnectAttempts?: number;               // default 5; counter resets to 0 on each successful reconnect (FE #18)
  reconnectBackoff?: {
    initialMs:  number;                        // default 500
    maxMs:      number;                        // default 30_000
    multiplier: number;                        // default 2
    jitter:     number;                        // default 0.3
  };

  // Ready state
  autoWaitForReady?: boolean;                  // default FALSE (FE #5 — was true; silent-buffer footgun)
  waitForReadyTimeoutMs?: number;              // default 10_000

  // Outgoing send queue (FE #11, #12 — renamed from flat maxPendingOutgoing)
  outgoingQueue?: {
    maxMessages?: number;                      // default 100
    onOverflow?: "reject" | "dropOldest" | "dropNewest";  // default "reject" — throws QueueFullError
  };

  // Audio
  audioChunkSize?: number;                     // default 500_000 bytes, min 1024, max 512_000 (server limit)

  // Rate limiting (server caps at 6 req/sec per connection; throttle resets on ConnectionOpened)
  maxRequestsPerSecond?: number;               // default 6; set to Infinity to disable

  // Liveness (§5.2 — wall-clock anchored, FE #1)
  inboundIdleTimeoutMs?: number;               // default 45_000; Date.now()-based, not setTimeout-anchored
  heartbeatIntervalMs?: number;                // default 30_000 (Node only; uses .unref())

  // Observability
  logger?: OjinLogger;
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";  // default "warn"
}
```

**Changes vs v0.1 (full list):**

- `reconnectAttempts` → split into `initialConnectAttempts` + `maxReconnectAttempts`. Runtime `ConfigurationError` guard on the old name for one minor version.
- `reconnectDelay` (seconds) → `reconnectBackoff.initialMs` (ms) + `initialConnectDelayMs` (ms). Runtime guard — silent alias rejected because seconds→ms would cause a 1000× bug (§11.1, FE finding 16).
- `maxPendingOutgoing` flat option → nested `outgoingQueue` (FE finding 12). Runtime guard on the flat name.
- `autoWaitForReady` default flipped to `false` (FE finding 5). See §4.5 for rationale.
- `receiveMessage()` and `startInteraction()` deleted outright (§4.3). No deprecation, no flag, no replacement — events are the only delivery path.
- Event names ship dotted from day one (`session.ready`, `interaction.response`, `connection.reconnecting`, …) — no flat-name aliases.
- Added: `maxRequestsPerSecond` (§5.4, new).
- Added: `inboundIdleTimeoutMs`, `heartbeatIntervalMs` (§5.2, new).
- Added: `logger`, `logLevel` (§5.3, new).

---

**End of plan.**
