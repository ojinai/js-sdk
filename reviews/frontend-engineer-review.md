# Senior Frontend Engineer Review — Ojin TS SDK `PLAN.md`

## Executive summary

The single worst problem in this plan is that the whole liveness/reconnect story (§5.2) is built on `setTimeout`-based idle timers in an environment where `setTimeout` is the least reliable primitive a browser gives you. Chromium throttles it to 1 Hz in background tabs, iOS Safari freezes it entirely under Low Power Mode or lock-screen, and Safari BFCache suspends the whole event loop without firing a `close`; the plan's answer to all of this is one sentence in R11 plus one paragraph in §13 #10. A user who backgrounds the tab for 60 seconds while driving or walking has, on the plan as written, undefined SDK behaviour: the idle timer may fire hours later, the WebSocket may be a zombie with `readyState === OPEN` but no I/O, and the next `sendText()` will succeed-then-silently-vanish. From there the plan has more problems than I expected for a draft tagged "for external review": §7.4 handwaves the audio jitter buffer and lip-sync — the two hardest problems in any avatar SDK — in three bullet points while downgrading the effort from XL to L; §4.5's `autoWaitForReady: true` default silently changes `sendMessage`'s contract from "throws" to "buffers forever" without signaling back-pressure; the event API (Appendix A) has no `once` and no `off`-by-registration-token, which will cause leaks in every React integration; §4.3's "first `receiveMessage()` call flips enqueue on" is a hidden-mode-flag that wires up racy behaviour depending on call order; the dual `maxQueuedMessages` / `maxPendingOutgoing` option names are collision bait that §12 admits was considered; §11's "no alias for `reconnectDelay` because seconds→ms would cause a 1000× bug" is right about the risk but wrong about the mitigation — a runtime validator is the cheap fix; and the plan ships v1.0 to real users with **zero** real-browser tests in CI (§9.1 defers Playwright to post-v1.0, while R13 is flagged med/med with the same deferral). I am outside the 15–30 range at 27 findings — the plan sits just above the middle of that window in my estimation. The plan is not ready for GA in its current form, and I would not sign off on §7.4 or §5.2 without concrete redesign.

---

## Findings

### 1. `setTimeout`-based idle timer cannot survive a backgrounded mobile tab

- **Severity:** Critical
- **Focus area:** 1 (timer behaviour under tab throttling)
- **Why it matters:** A user on iOS Safari who switches apps for 90 seconds returns to a client that still thinks it is "connected" (WebSocket `readyState === OPEN`) because the 45-second `inboundIdleTimeoutMs` timer was suspended along with the tab. The next `sendText()` goes into the kernel socket buffer, the server has long since closed the TLS session at its own idle threshold, and the response never arrives. No event fires to tell the consumer anything is wrong until the TCP RST eventually propagates — often after the user has given up. This is the single most common real-world failure mode for WebSocket SDKs on mobile and the plan does not address it.
- **Evidence from the plan:** §5.2: *"track the monotonic timestamp of the last inbound frame … If no frame arrives within `inboundIdleTimeoutMs` (default `45_000` — must exceed the server's `sessionPing` cadence with headroom), treat as dead and trigger reconnect"*. §13 #10 concedes the problem — *"Browsers throttle `setTimeout`/`setInterval` in background tabs, so the `inboundIdleTimeoutMs` check (§5.2) may fire late. On `pageshow`, the client evaluates elapsed idle time"* — but then parks the solution in the *concepts page*. §5.2 itself does not mention `visibilitychange`, `pageshow`, `pagehide`, `Date.now()`, or `performance.now()` anywhere in its 15 bullet lines. It specifies a `setTimeout`-derived check without specifying the clock.
- **Recommended change:** Specify the implementation in §5.2, not in a docs page:
  1. Store the last-inbound timestamp with `Date.now()` (wall clock — never throttled) **and** `performance.now()` (both for drift diagnostics).
  2. Do **not** rely on a `setTimeout(check, 45_000)` loop for liveness at all. Run the check opportunistically on every inbound frame and on the `visibilitychange`, `pageshow`, `focus`, and `online` events.
  3. On `document.visibilityState === "visible"` transitioning from `"hidden"`, synchronously compare `Date.now() - lastInboundAt`; if over threshold, emit `ConnectionStateChanged(Reconnecting)` and kick a new connect without waiting for the foreground timer to catch up.
  4. Make `inboundIdleTimeoutMs` clock-source-agnostic: the *time* check uses `Date.now()`; any `setTimeout` is a belt-and-braces wake-up, not the authority.
  5. Add an explicit negative-path test that uses `vi.useFakeTimers()` plus a manual `Date.now()` jump of 90 s to prove the reconnect path fires on foregrounding without the timer having fired.

### 2. R11 "Safari BFCache" mitigation is one sentence and load-bearing

- **Severity:** Critical
- **Focus area:** 2 (Safari BFCache / mobile-Safari WS)
- **Why it matters:** On iOS Safari navigating back to a cached page, the JS context resumes but the old WebSocket is already dead — Safari does not fire a `close` event on BFCache eviction consistently. A consumer who built a one-page-app with Ojin embedded will return from the back button to a ghost client: events wired, internal state says Connected, sends silently drop. `pageshow` with `persisted === true` is the only reliable signal, and it only fires if the page was actually BFCache'd. Today's plan does not mention `persisted`, does not specify that `pagehide` must proactively close the socket, and does not commit to reconnecting on `pageshow`.
- **Evidence from the plan:** R11 in §12: *"Safari BFCache (back/forward cache) silently suspends the WebSocket; no `close` event until `pageshow`. Reconnect logic can fight BFCache. Mitigation: Listen for `pagehide`/`pageshow`, treat as controlled disconnect/reconnect boundary; negative-path test."* That is the entire treatment. §5.2, §4.5, and §5.1 — the sections where this would actually be implemented — make zero references to BFCache, `pageshow`, or `persisted`.
- **Recommended change:** Promote R11 from a one-line risk-register entry into an explicit subsection in §5.2:
  1. On `pagehide` with `event.persisted === true`, proactively call `transport.close()` and set state to `Disconnected` (not `Reconnecting`). This prevents returning to a half-alive socket.
  2. On `pageshow` with `event.persisted === true`, unconditionally re-enter the reconnect state machine.
  3. On `pagehide` with `persisted === false` (normal unload), fire-and-forget `close()` so the server gets a clean disconnect.
  4. Add a Playwright test that navigates away and uses the browser back button (BFCache must be enabled) — happy-dom cannot reproduce this.
  5. Document in §5.2 that this is Safari-specific and that Chromium behaves differently (WS is kept alive).

### 3. Audio jitter buffer and lip-sync are waved through in three bullets

- **Severity:** Critical
- **Focus area:** 5 (audio jitter buffer / lip-sync)
- **Why it matters:** Lip-sync is the feature; if the audio drifts ±40 ms from the video over a two-minute session, the avatar looks broken and the product fails. §7.4 promises this as v2.0-L effort while providing no specification for: the clock the jitter buffer runs against (`AudioContext.currentTime` is the only correct choice, not `Date.now()`); the buffer depth (too shallow = audible underruns on mobile radio jitter; too deep = visible lag behind the video); what to do on underrun (insert silence? time-stretch? jump?); how to re-anchor video when audio underruns; and the user-gesture gate for `AudioContext` creation on iOS. Any one of those is a week of work. The L sizing is not defensible.
- **Evidence from the plan:** §7.4: *"**Audio:** `AudioContext` + `AudioBufferSourceNode` + jitter buffer. This is the main remaining complexity; we need to align the audio playhead with the video tick to avoid lip-sync drift."* That is the entire audio design. There is no mention of `AudioContext.currentTime`, no mention of `start(when)` scheduling, no mention of iOS's `suspended`-until-gesture state, no buffer-depth number.
- **Recommended change:** Rewrite §7.4 with a real spec or defer DOM helpers to v2.1. Specifically:
  1. Commit to `AudioContext.currentTime` as the master clock. Video frames render on `requestAnimationFrame`, but the display-time of each frame is computed from the per-frame PCM's scheduled audio playhead (`sourceNode.start(audioCtx.currentTime + leadMs / 1000)`).
  2. Specify a target buffer depth (80–120 ms is the industry norm for conversational avatars), `minBufferMs`, `maxBufferMs`, and an underrun policy (emit silence + `underrun` event; do not time-stretch in v2).
  3. Specify iOS user-gesture handling: expose `await client.unlockAudio()` that must be called from a user-interaction handler; throw a typed `AudioLockedError` if `streamToVideoElement`/`streamToCanvas` is called first.
  4. Upgrade the effort estimate back to XL. L is wrong.
  5. Add a measurable lip-sync acceptance criterion to §15.3 (e.g., median audio-video offset ≤ 20 ms over a 60 s session, p95 ≤ 40 ms).

### 4. happy-dom cannot prove browser correctness; v1.0 ships with no real-browser CI

- **Severity:** Critical
- **Focus area:** 10 (happy-dom vs real-browser fidelity)
- **Why it matters:** happy-dom's `WebSocket` is a mock — it does not reproduce Safari's `Blob`-vs-`ArrayBuffer` default `binaryType`, does not reproduce Safari's "error fired without `close`" path, does not enforce the TextEncoder/TextDecoder encoding quirks that differ across WebKit and Gecko, and does not BFCache. The plan explicitly ships v1.0 with only happy-dom in CI and defers Playwright to v1.5. For an SDK whose product positioning (§2.3) is *"browser-first, Node second"*, that is a gap between the marketing and the test pyramid.
- **Evidence from the plan:** §9.1: *"Integration (browser) | Vitest + `happy-dom` + mock `WebSocket` | URL-based auth, no header path, JSON-only heartbeat, `Blob`/`ArrayBuffer` handling."* §9.1 E2E row: *"Playwright (post 1.0)"*. R13: *"happy-dom does not faithfully reproduce real-browser `WebSocket` / `Blob` edge cases … Supplement happy-dom with Playwright e2e post-v1.0 (v1.5 at latest)."* The plan rates R13 as *med/med* and ships anyway.
- **Recommended change:** Add one Playwright smoke job to §15.1 acceptance criteria before v1.0 ships:
  1. Single test, three browsers (Chromium, Firefox, WebKit), one assertion: connect → receive `SessionReady` → send text → receive one `InteractionResponse` → disconnect cleanly.
  2. Run against the same mock WS server that the happy-dom tests use (no staging backend dependency).
  3. Gate the v1.0 release tag on this job being green.
  4. If the team refuses to take on Playwright for v1.0, downgrade the `browser-first` positioning in §2.3 honestly: call it "Node tier-1, browser tier-2-in-v1.0".

### 5. `autoWaitForReady: true` silently turns `sendMessage` from "throws" to "buffers forever"

- **Severity:** High
- **Focus area:** 12 (consumer API ergonomics)
- **Why it matters:** Today's `sendMessage` throws if the server is not ready — loud and debuggable. §4.5 changes the default to `autoWaitForReady: true`, which means `sendMessage` now waits indefinitely (bounded only by `waitForReadyTimeoutMs: 10_000` — and only if the consumer noticed that option exists). A mis-configured client with a bad `configId` and `autoWaitForReady: true` produces a UI that hangs for 10 seconds with no user-visible signal that anything is wrong, then rejects with a TimeoutError that looks like a network problem but isn't. This is a worse failure mode than the original throw.
- **Evidence from the plan:** §4.5: *"`autoWaitForReady` option (default `true`). When `true`, `sendMessage` internally awaits `waitForReady()` before sending."* Appendix A lists `autoWaitForReady?: boolean; // default true` and `waitForReadyTimeoutMs?: number; // default 10_000`. Nothing in §4.5 requires a distinguishable error for "never became ready" vs "timed out mid-session".
- **Recommended change:**
  1. Make the `autoWaitForReady` path emit `ConnectionStateChanged(Pending)` or a new `WaitingForReady` event the first time it blocks, so UIs can render a spinner.
  2. On timeout, throw a `ReadyTimeoutError` (distinct from the generic `TimeoutError` in §5.4) with `details.configId`, `details.elapsedMs`, and `details.lastConnectionState` so the common "bad configId" error surfaces clearly.
  3. Document in §4.5 and in README that the default swallows back-pressure — consumers who need hard back-pressure set `autoWaitForReady: false`.
  4. Consider flipping the default to `false`. The Python parity argument is weak because Python has `await` semantics the caller controls; JS consumers do not usually want a 10-second silent wait.

### 6. Frame-rendering plan is "canvas now, Worker later" — this never works

- **Severity:** High
- **Focus area:** 4 (real-time frame rendering)
- **Why it matters:** `createImageBitmap(blob)` returns a promise that *does* decode off-thread in all modern browsers (good), but `ctx.drawImage(bitmap, 0, 0)` happens on the main thread and competes with React render, layout, and user input for every one of 25 frames per second. On a mid-tier Android device with 1280×720 JPEGs this is measurable jank as soon as the page contains anything else running at 60 Hz. Retrofitting an `OffscreenCanvas` + Worker path into a shipped v2.0 API breaks every consumer who passed an `HTMLCanvasElement`. The design choice is cheap to get right on day one and expensive to retrofit.
- **Evidence from the plan:** §7.4: *"**Video:** `createImageBitmap(new Blob([jpegBytes], {type: "image/jpeg"}))` → `ctx.drawImage(bitmap, 0, 0)` at the 25 fps tick. Universal browser support; no WebCodecs, no Safari fallback, no YUV math."* §7.4 does not mention `OffscreenCanvas`, workers, `transferControlToOffscreen()`, or main-thread contention.
- **Recommended change:**
  1. Ship `streamToCanvas(canvasEl)` in v2.0 calling `canvasEl.transferControlToOffscreen()` and moving the draw loop into a Worker on its first invocation.
  2. Fall back to main-thread draw only when `transferControlToOffscreen` is unavailable (older Safari). Gate behind a feature-detect, not a runtime config flag.
  3. Close every `ImageBitmap` after `drawImage`: the plan never states who owns `.close()`, and forgetting this leaks GPU memory on Chromium and Firefox (see finding 9).
  4. Specify a render budget in §15.3: ≤ 8 ms main-thread cost per frame on a 2021 mid-tier Android (e.g., Pixel 6a).

### 7. React hooks spec (§8.2) is three lines and will leak sockets in Strict Mode

- **Severity:** High
- **Focus area:** 3 (React 18 Strict Mode / Suspense / hooks)
- **Why it matters:** React 18 Strict Mode mounts → unmounts → remounts every effect in dev, including the one inside `useOjinClient(options)`. The plan claims `connect()`/`close()` are idempotent, but the actual source (`ojin-client.ts:63-69`) only guards `Connecting` and `Connected` states — an unmount during `Connecting` calls `close()` which sets `Disconnecting → Disconnected`, the remount immediately calls `connect()` again, and because the transport promise from the first `connect()` is still in-flight, you end up with two sockets. The plan's test for this (§13 #10) is one sentence: *"Explicit test added for double connect/close."* That does not cover the overlap case.
- **Evidence from the plan:** §8.2: *"`useOjinClient(options)` — manages lifecycle. `useOjinStream(client, videoRef)` — paints frames. `useOjinMessages(client)` — returns accumulating message log."* That is the entire spec. §13 #10: *"`connect()` is idempotent (guarded by state check at `src/ojin-client.ts:63-69`); `close()` is safe to call on an already-closed client."* Reading that actual line range: the guard returns early only on `Connected` or `Connecting`. It does not handle `close()` arriving while the first `connect()` is still in its retry loop at `ojin-client.ts:99-104`.
- **Recommended change:**
  1. Rework `connect()`/`close()` to be re-entrant using an AbortController passed through the retry loop (`for` loop at `ojin-client.ts:74`): `close()` aborts the in-flight attempt and guarantees transport is torn down before returning.
  2. Spec §8.2 with real implementation notes: `useOjinClient` must use a `useRef` for the client instance and must not recreate on every render; the effect's cleanup must `await` `close()` and the next effect must `await` that cleanup's promise before starting.
  3. Add a negative-path test to §9.4 specifically for "unmount during Connecting" (not just "double connect/close"). Drive it with a mock server that delays `SessionReady` by 2 s and run the hook inside a Strict Mode `<React.StrictMode>` test harness.
  4. `useOjinStream(client, videoRef)` needs explicit spec for the Suspense case: if the component suspends between `videoRef.current = <el>` and the effect running, the video element reference can change. Use a stable `videoId` string, not a ref, or document the constraint.

### 8. `receiveMessage()`-flips-the-switch in §4.3 is a hidden mode bug

- **Severity:** High
- **Focus area:** 12 (ergonomics) / 7 (lifecycle)
- **Why it matters:** §4.3 says the internal queue only starts filling *after* the first call to `receiveMessage()`. That means a consumer who calls `receiveMessage()` from a `setTimeout(..., 0)` after `connect()` gets different results than one who calls it synchronously on `SessionReady`: the first misses every frame that arrived between connect and the timeout. The "listener registered on first call" design introduces order-dependent behaviour in the API that type signatures cannot express. This will surface as a mysterious intermittent test-flake and a "works on my laptop" bug report.
- **Evidence from the plan:** §4.3: *"`receiveMessage()` is opt-in and lazy. Until the consumer calls `receiveMessage()` for the first time, nothing is enqueued — server messages only fire events. On first call, the SDK attaches an internal listener that begins feeding a bounded queue; subsequent calls dequeue from it. This removes the race-on-listener-registration entirely and guarantees zero double-delivery."*
- **Recommended change:**
  1. Either fully deprecate `receiveMessage()` in v1.0 (throw if called; document as v2.0-removed) **or** make it opt-in via an explicit constructor option (`enableReceiveMessageApi: true`). No hidden state flips.
  2. If §4.3 is kept as-is, document the caveat *loudly* in the JSDoc: *"Messages received between `connect()` and your first `receiveMessage()` call are delivered as events only, not enqueued. This is not a bug."*
  3. Add a test: `await client.connect(); await sleep(1000); await client.receiveMessage();` and assert it does **not** return a previously-received `SessionReady` — i.e., document the lossy behaviour explicitly.

### 9. `ImageBitmap` ownership and memory leaks — plan is silent

- **Severity:** High
- **Focus area:** 6 (memory on long sessions)
- **Why it matters:** At 25 fps × 720p, each `ImageBitmap` is ~2.6 MB of GPU-backed memory. If `OjinEvent.InteractionResponse` hands the bitmap (or the JPEG bytes) to consumers and the consumer forgets to `.close()` it, the tab's GPU memory grows unboundedly until either the browser kills the tab (iOS: ~350 MB) or the OS kills the browser (Android). The plan's 10-minute soak test (§15.1) is not long enough to catch a slow leak at 1 bitmap/frame in the consumer path. More importantly, the plan never says whether the SDK owns or the consumer owns the bitmap lifecycle.
- **Evidence from the plan:** §15.1 acceptance criterion: *"10-minute soak test at simulated stream rate runs without unbounded RSS growth (numeric target set in v1.5 after baseline measurement)."* §7.4 describes the decode path but does not mention `.close()`, and the event `[OjinEvent.InteractionResponse]: (message: OjinInteractionResponseMessage) => void` (Appendix A) passes the message through — Appendix A does not document whose responsibility the `ImageBitmap` / `Uint8Array` cleanup is.
- **Recommended change:**
  1. Decide the ownership model explicitly in §7.4. Recommendation: the SDK retains ownership of the `ImageBitmap` while emitting it; after the event handler returns (or after `queueMicrotask`), the SDK calls `.close()`. Document that handlers must not keep references.
  2. If consumers need to retain a frame (e.g., for a "current frame" thumbnail), expose `message.retainFrame(): ImageBitmap` that transfers ownership and *removes* the SDK's `.close()` call — so the leak is detectable.
  3. Promote the soak test to 60 minutes minimum with a gzip-bytes-received budget *and* `performance.memory.usedJSHeapSize` (Chromium only) growth budget. 10 minutes on a synthetic stream does not reproduce real user sessions.
  4. Add a dedicated test: send 10 000 frames without the consumer retaining any, assert heap growth under 5 MB.

### 10. No `once()` / no listener token — React consumers will leak

- **Severity:** High
- **Focus area:** 12 (ergonomics) / 7 (lifecycle)
- **Why it matters:** `OjinEventEmitter.off(event, cb)` requires passing the *same function reference* back. React consumers typically write `client.events.on(OjinEvent.InteractionResponse, (msg) => setFrame(msg))` — an inline arrow that cannot be `off`'d. The plan's Appendix A does not expose `once()` or return an unsubscribe function from `on()`. Every React integration will leak listeners on every re-render unless the consumer manually hoists the callback to a `useCallback`. That's a footgun the SDK should close, not push onto the consumer.
- **Evidence from the plan:** Appendix A: *"class OjinEventEmitter { on<K extends OjinEvent>(event: K, cb: OjinEventCallbacks[K]): void; off<K extends OjinEvent>(event: K, cb: OjinEventCallbacks[K]): void; removeAllListeners(event?: OjinEvent): void; }"*. No `once`, no `Subscription` return type.
- **Recommended change:**
  1. Change `on()` to return an unsubscribe function: `on<K>(event, cb): () => void`. Industry standard; no ambiguity on which listener is being removed.
  2. Add `once<K>(event, cb): () => void` with the same return.
  3. Keep `off()` for back-compat but document it as "prefer the return value of `on()`".
  4. Update §8.2 hook spec: `useOjinClient` and friends must use the unsubscribe function in their effect cleanup, not `off()`.

### 11. Pre-ready queue drops the oldest — wrong for interactive chat

- **Severity:** High
- **Focus area:** 12 (ergonomics)
- **Why it matters:** §4.5 queues up to 100 outgoing messages before `SessionReady`; §4.4 says overflow drops **oldest**. For an interactive avatar where the user types "Hello, what's the weather?" and the first 10 messages are the utterance itself, dropping the oldest means the server receives garbled input in order. For a conversational app, drop-newest is the correct semantics (or, better, rejecting the offending send with a `QueueFullError` so the UI can backpressure). Drop-oldest is right for telemetry streams, not for ordered user input.
- **Evidence from the plan:** §4.4: *"`events.emit(OjinEvent.QueueOverflow, { dropped: N, queueType: "incoming" })` fired at most once per 5-second window. Same event with `queueType: "outgoing"` fires on pending-outgoing overflow (§4.5, §5.1)."* §4.3: *"Once full, drop the **oldest** and emit `OjinEvent.QueueOverflow`"* — the plan applies drop-oldest to both incoming (reasonable) and outgoing (wrong).
- **Recommended change:**
  1. For `maxPendingOutgoing`, reject the `sendMessage` promise with a typed `QueueFullError` (add to §5.4 error list). Do not silently drop.
  2. Make the behaviour configurable: `onOutgoingOverflow: "reject" | "dropOldest" | "dropNewest"` — default `"reject"`. Telemetry-style consumers opt into drop-oldest explicitly.
  3. For `maxQueuedMessages` (incoming, legacy `receiveMessage` path), drop-oldest is fine; keep it.
  4. Document the semantic difference in §4.4 explicitly — do not rely on readers inferring it from the `queueType` string.

### 12. `maxQueuedMessages` vs `maxPendingOutgoing` — collision bait

- **Severity:** High
- **Focus area:** 12 (ergonomics)
- **Why it matters:** Two options with near-identical names, opposite directions. Consumers will set `maxQueuedMessages` expecting it to control the send buffer during reconnect and get a different failure mode than they asked for. The default delta (1000 vs 100) makes the bug subtle — a consumer with 250 queued outgoing messages thinks they're fine and isn't. This is exactly the category of footgun the plan acknowledges in its own R-register (R5) but does not fix in the API.
- **Evidence from the plan:** Appendix A: *"maxQueuedMessages?: number; // default 1000 (incoming; only when receiveMessage() used)"* and *"maxPendingOutgoing?: number; // default 100 (outgoing; before SessionReady + during reconnect)"*.
- **Recommended change:** Rename to surface direction:
  ```ts
  incomingQueue?: { maxMessages?: number };  // default { maxMessages: 1000 }
  outgoingQueue?: { maxMessages?: number; onOverflow?: "reject"|"dropOldest"|"dropNewest" };
  ```
  Grouping them as nested objects makes the direction grammatically unavoidable at the call site. Kill the flat `maxQueuedMessages` and `maxPendingOutgoing` entirely — this is a major bump so the break is cheap now.

### 13. Logger + redaction on the hot path — no fast-path short-circuit specified

- **Severity:** High
- **Focus area:** 9 (logger/redaction on hot path)
- **Why it matters:** At 25 fps × potentially multiple metadata fields per frame, the plan's redaction routine runs ~100×/sec minimum. R12 flags it as *low/med* with a hand-wave mitigation — *"Fast-path when log level filters out the call"* — but does not specify the implementation. If `this.logger.debug(msg, meta)` is called and the level is `warn`, the arguments are still evaluated: the `meta` object is still constructed, its `apiKey` field still checked by redaction, and any string concatenation in `msg` still runs. The short-circuit must happen at the call site, not inside the logger, or the overhead is real.
- **Evidence from the plan:** R12: *"Logger + redaction overhead in hot frame path (every `handleMessage` now goes through the pipeline) … Fast-path when log level filters out the call; microbenchmark before GA."* §5.3 specifies redaction on `meta` but not the short-circuit mechanism.
- **Recommended change:**
  1. Add a public `logger.isDebugEnabled()` / `isLevelEnabled(level)` method to the `OjinLogger` interface (§5.3, Appendix A).
  2. Wrap every call site in the hot path: `if (this.logger.isDebugEnabled()) this.logger.debug("frame", { ... })`.
  3. Implement redaction as a fast key-whitelist pass (iterate the top-level keys of `meta`, replace the three known-sensitive keys with `***`). Do **not** do regex-over-JSON — that is O(n) in payload length and quadratic for nested structures.
  4. Add a Vitest bench (§9.1 already lists it) that asserts logger.debug-at-warn-level is under 100 ns on Node 20.
  5. Document the contract: "The SDK never serializes `meta` until the logger accepts it."

### 14. Redaction strategy is not specified — regex-over-JSON would be quadratic

- **Severity:** High
- **Focus area:** 9 (logger/redaction on hot path)
- **Why it matters:** §5.3 says "strip `apiKey`, `api_key`, `authorization`, `session_token`" but does not say **how**. A naive implementation uses `JSON.stringify(meta)` + regex replacement — that allocates a string proportional to the entire frame payload size on every log call (including the video/audio bytes in a passed-through message, if a consumer ever logs one). A 2.6 MB video frame serialized to JSON and regex-scanned costs ~15 ms on mid-tier mobile — more than one full frame period.
- **Evidence from the plan:** §5.3: *"`meta` objects are **redacted** via a shared redaction pass (strip `apiKey`, `api_key`, `authorization`, `session_token`)."* No further implementation notes. `redactUrl(u: string)` in §4.1 is separate and scoped to URLs.
- **Recommended change:**
  1. Specify implementation explicitly in §5.3: key-whitelist walk of the top level of `meta` only; nested objects not traversed (document this as a constraint: "do not put secrets in nested meta fields"). O(k) where k is the number of top-level keys.
  2. Forbid passing `OjinMessage` / `Uint8Array` as `meta` — define a `LoggableMeta = Record<string, string | number | boolean | null>` type and enforce at the interface level.
  3. Add a bench asserting redaction cost under 1 µs per call for up to 20 top-level keys.

### 15. Tree-shaking with `preserveModules: true` — profiling utilities will drag into every consumer bundle

- **Severity:** High
- **Focus area:** 11 (bundle size / tree-shaking)
- **Why it matters:** `src/index.ts` re-exports `FPSTracker`, `LatencyTracker`, `NIL_UUID`, `bytesToUuid`, `uuidToBytes`, raw `serialize*`/`deserialize*` functions, and `MessageType`. A consumer who imports only `OjinClient` expects to tree-shake the rest. But `preserveModules: true` preserves the module graph as separate files — which is fine for ESM tree-shaking *if* the consumer's bundler is well-configured. `LatencyTracker` uses `static` class fields that touch `Map`s at module-init time; classes with top-level side effects defeat tree-shaking in some bundler configurations. The plan sets a "10% gzip growth budget" (§6.6) without a recorded baseline, so there is no way to know whether the surface has already leaked.
- **Evidence from the plan:** §6.6: *"Track `dist/esm/index.js` gzip size in CI. Fail the PR if it grows by more than 10% without explicit override."* §1.1: *"`preserveModules: true` for tree-shaking."* Appendix A exports (via §1.1 claim of clean tree-shake) do not match what `src/index.ts` actually re-exports — the index ships profiling utilities on the public surface.
- **Recommended change:**
  1. Remove `FPSTracker` and `LatencyTracker` from `src/index.ts`. They are internal diagnostics. If consumers need them, expose via `@ojinai/js-sdk/profiling` subpath (package.json `exports` field).
  2. Verify tree-shaking concretely: add a CI step that builds a dummy consumer importing only `OjinClient`, runs Rollup against it, and asserts the output does not contain `FPSTracker` or `LatencyTracker` class names.
  3. Record the baseline gzip size at the start of the v1.0 work, not at the end. Without a baseline the 10% check is meaningless.
  4. Audit `LatencyTracker`'s `static` `Map` initializers (`src/utils/profiling.ts:96-99`) — convert to lazy getters if they cause sideeffect retention.

### 16. `reconnectDelay` seconds→ms rename has no runtime guard

- **Severity:** High
- **Focus area:** 12 (ergonomics) / 11 (migration)
- **Why it matters:** §11.1 admits the risk: silent alias for `reconnectDelay` would cause a 1000× bug. The plan's chosen mitigation is "clean break, force read the CHANGELOG." But a consumer upgrading by running `pnpm up` with a lock-file strategy will not read the CHANGELOG — the TypeScript compiler will catch them only if they hand-wrote the option name and only if they're on strict. If they used `...prevOptions` spread, the rename causes the old value to be ignored and the default to take over silently. Not a 1000× bug, but a *this worked before* bug.
- **Evidence from the plan:** §11.1: *"`reconnectDelay` (seconds) → `reconnectBackoff.initialMs` / `initialConnectDelayMs` (ms) | Field rename and unit change (s → ms) | Clean break at major bump. A silent alias would risk a 1000× delay bug; better to force consumers to read the migration note."*
- **Recommended change:**
  1. Add a constructor-time runtime validator: if `options.reconnectDelay` is defined (old name), throw `ConfigurationError` with message *"`reconnectDelay` was removed in v1.0. Use `reconnectBackoff.initialMs` (milliseconds, not seconds). See the v1.0 migration guide."* — loud failure, not silent.
  2. Same treatment for `reconnectAttempts`: if defined and neither of the new names are, throw with migration text.
  3. Keep this for one minor version (v1.0 → v1.1), then remove.
  4. Add a test to §9.4: "legacy option name throws with migration message."

### 17. No Node `ping()` cleanup on close — active heartbeat will keep the process alive

- **Severity:** High
- **Focus area:** 7 (lifecycle across reconnects)
- **Why it matters:** §5.2 specifies `heartbeatIntervalMs` (Node only) that calls `ws.ping()` every 30 s. The plan does not specify `clearInterval` on `close()` or on reconnect. The current source (`ojin-client.ts:113-130`) has no interval to clear yet, so the bug does not exist today. If the author adds `setInterval(() => this.transport.ping(), 30_000)` naively, the interval survives the reconnect and fires `ping()` on the dead transport, or — worse — keeps the Node process alive indefinitely (`setInterval` by default counts against the event-loop keepalive). §13 #11 promises an audit but does not specify it.
- **Evidence from the plan:** §5.2: *"Node path additionally sends active pings … client calls `ws.ping()` every `heartbeatIntervalMs` (default `30_000`); pong is consumed automatically by `ws`."* §13 #11: *"Listener cleanup audited: all `addEventListener` paired with `removeEventListener`; all `setInterval` cleared in `close()`; `responseResolvers` resolved with `null` on close. Added to negative-path tests."* The audit is promised, not specified.
- **Recommended change:**
  1. Specify in §5.2: the ping interval is stored on the instance; cleared in `close()` before the transport is nulled; cleared at the start of every reconnect attempt; restarted after successful reconnect.
  2. Use `interval.unref()` on Node so the interval never blocks process exit.
  3. Add explicit §9.4 negative-path test: "connect + close + assert `process._getActiveHandles().length` unchanged" (or equivalent — Vitest's `--detectOpenHandles` works).
  4. Apply same treatment to the pending-outgoing queue flush timer, the backoff timer, and the ready-wait timer (see finding 18).

### 18. Reconnect backoff and ready-wait timers: no cancellation spec

- **Severity:** High
- **Focus area:** 7 (lifecycle)
- **Why it matters:** §5.1 specifies `min(initial * multiplier^attempt, max) * (1 ± jitter)` backoff, but says nothing about what happens if `close()` is called during the sleep. The natural implementation — `await new Promise(r => setTimeout(r, delay))` (which is what exists today at `ojin-client.ts:102`) — is not cancellable. `close()` sets state to `Disconnected`, the setTimeout fires 30 s later, and the reconnect loop does another attempt against a closed client. Same story for `waitForReady(timeoutMs)` — the rejection on timeout can race the rejection on close.
- **Evidence from the plan:** §5.1: *"Sleep `min(initial * multiplier^attempt, max) * (1 ± jitter)`. Retry `connect()` up to `maxReconnectAttempts` times."* No AbortController. §4.5: `waitForReady(timeoutMs?: number): Promise<OjinSessionReadyMessage>` — no spec for what happens if `close()` is called while awaiting.
- **Recommended change:**
  1. Build every internal `await sleep(ms)` on an AbortController held on the instance. `close()` aborts the controller; every sleep rejects with a shared `OperationAborted` error that the reconnect loop treats as "stop".
  2. Specify in §4.5 that `waitForReady` rejects with `ConnectionError(NotConnected)` if `close()` is called during the await. Test it.
  3. Specify in §5.1 that `maxReconnectAttempts` is reset to zero on every successful reconnect (so "five drops in a row" is the limit, not "five drops per session lifetime"). The plan is ambiguous on this.

### 19. `apiKey` surface: Appendix A still requires `apiKey` on `OjinClientOptions`

- **Severity:** Medium
- **Focus area:** 12 (ergonomics) / Other
- **Why it matters:** The plan introduces `unsafe_createClientWithApiKey(apiKey, configId, options)` as the factory (§4.1) — a clear API — but Appendix A still lists `apiKey: string` on `OjinClientOptions` as required. Consumers who bypass the factory and call `new OjinClient({...})` directly trip the same security footgun the factory was named `unsafe_` to advertise. Either the direct constructor should be hidden (non-exported) or `apiKey` should be optional and a session-token path should exist for v1.0.
- **Evidence from the plan:** Appendix A: *"export interface OjinClientOptions { … wsUrl: string; apiKey: string; configId: string; mode?: "dev" | null; … }"* and *"export function unsafe_createClientWithApiKey(apiKey: string, configId: string, options: Omit<OjinClientOptions, "apiKey" | "configId">, …)"*. The `Omit` is the right shape for the factory but does not stop direct construction.
- **Recommended change:**
  1. Keep `OjinClient` class exported but mark the constructor `@internal` in JSDoc and strip it from the TypeDoc output.
  2. Or: narrow the constructor to take a branded type `{ __ojinAuth: OjinAuthContext }` that only the factories can produce. Consumers cannot construct the client without going through a factory.
  3. If neither is acceptable, rename the raw option `unsafe_apiKey` so the footgun is visible at every call site.

### 20. `unsafe_createClientWithApiKey` console.warn fires once — or once per tab?

- **Severity:** Medium
- **Focus area:** 12 (ergonomics) / Other
- **Why it matters:** §4.1 adds a runtime `console.warn` on first use of the factory. The plan does not specify the scope — once per process? Once per module load? Once per call? In a browser SPA that re-imports the SDK across route transitions with a dynamic import, "once per module load" and "once per process" are different things. Consumers will complain that their console is noisy; then silencing the warn will silently strip the security signal.
- **Evidence from the plan:** §4.1 step 3: *"Add a runtime `console.warn` on first use: 'OjinClient: API-key auth exposes your secret to the client. For production, use session tokens (available in v1.5).'"*
- **Recommended change:**
  1. Specify: once per JS realm (guard via a module-scoped boolean). Document that warnings may fire more than once across iframes or worker boundaries — this is a feature, not a bug.
  2. Route the warning through the injected logger (§5.3) at `warn` level, not `console.warn`. Consumers who set `logLevel: "error"` or `silent` get to decide.
  3. In production builds (stripped via §7.5's `NODE_ENV !== "production"` guard): leave the warning in even in prod — this is a security signal, not a dev aid. §7.5 and §4.1 disagree with each other on this; resolve it.

### 21. `Uint8Array<ArrayBuffer>` widening — fine, but test it against Node `Buffer` as an input

- **Severity:** Medium
- **Focus area:** 8 (Uint8Array interop)
- **Why it matters:** §4.6 removes the `<ArrayBuffer>` generic parameter, correctly calling it covariant-safe. But consumers passing Node `Buffer` (which extends `Uint8Array` but whose `.buffer` is often a shared pooled `ArrayBuffer`) into `OjinAudioInputMessage` can hit subtle bugs: `audioInt16Bytes.subarray(i, end)` creates a view backed by Node's pool, and `new Uint8Array(chunk)` (see `ojin-client.ts:306`) copies correctly but the plan does not guarantee the copy happens on every path. A `send(buffer)` with an unpooled region can surface the wrong bytes to the server.
- **Evidence from the plan:** §4.6: *"Remove `Uint8Array<ArrayBuffer>` — use plain `Uint8Array`. TS 5.7 introduced the generic parameter but older toolchains and Node's `Buffer` interop do not."* No test is specified against actual `Buffer` input.
- **Recommended change:**
  1. Add a §9.4 negative-path test: construct an `OjinAudioInputMessage` from a Node `Buffer` allocated from a pool (`Buffer.from(pool, offset, length)`); send it; read the bytes off the mock server and assert they match the intended slice, not the pool backing.
  2. Document in §4.6 that the SDK always defensively copies audio input internally (`chunkAndSendAudio` already does this at `ojin-client.ts:306`, but the invariant is not asserted).

### 22. `ConnectionClosed` as an object is right — but old-signature call sites break silently

- **Severity:** Medium
- **Focus area:** 12 (ergonomics) / 11 (migration)
- **Why it matters:** §5.5 changes `ConnectionClosed` from `(code, reason) => void` to `(info: {code, reason, disconnectReason}) => void`. Old listeners do not throw — they just receive the entire info object bound to `code` and `undefined` bound to `reason`. `typeof info === "object"` means `code === 1000` comparisons now evaluate to `false` without erroring. This is the same silent-failure mode the plan explicitly avoids for `reconnectDelay` (finding 16). Be consistent.
- **Evidence from the plan:** §5.5: *"This is the single *intentional* signature break in v1.0 event API. Document prominently; provide `code`/`reason` fields inside the object so the diff is small."*
- **Recommended change:**
  1. Same runtime guard as finding 16: in v1.0, emit an extra `ConnectionClosed:legacy` event (dotted name borrowed from v2.0) that preserves the old two-arg signature. Document as `@deprecated`, remove in v1.5.
  2. Or: keep the rename clean (plan as-is) but add a TypeScript codemod recipe to the migration guide with a concrete example, not just a single-line diff note.
  3. At minimum, add a CHANGELOG entry with a grep pattern consumers can run to find old signatures.

### 23. `SessionReadyPing` in Appendix A is exported but never emitted

- **Severity:** Medium
- **Focus area:** Other
- **Why it matters:** Appendix A exports `OjinSessionReadyPing` as a public server-message class. The source (`client-messages.ts:44-49`) has it with a `toProxyMessage()` that throws. The plan's §4.2 splits messages into client/server hierarchies — `OjinSessionReadyPing` is listed under `OjinServerMessage` — but §5.2 specifies that inbound `sessionPing` is handled by the transport and never becomes an `OjinSessionReadyPing` instance emitted to consumers. So the class is dead weight on the public surface, imported only to annotate a type that nothing constructs.
- **Evidence from the plan:** Appendix A: *"OjinSessionReadyMessage, OjinInteractionResponseMessage, OjinErrorResponseMessage, OjinSessionReadyPing extends OjinServerMessage"*. §5.2 specifies pings are tracked as a last-inbound timestamp only.
- **Recommended change:** Either emit it as an event (for consumers who want to see liveness signals) or remove it from the public exports. Dead API surface is worse than missing API surface — it invites consumers to handle a case that never fires.

### 24. Rate-limit throttle at 6 req/s — what about in-flight messages during reconnect?

- **Severity:** Medium
- **Focus area:** 12 (ergonomics) / 7 (lifecycle)
- **Why it matters:** §5.4 specifies a client-side throttle at `maxRequestsPerSecond: 6`. It is not clear whether the budget carries across reconnects. A consumer who sends 6 messages, drops, reconnects 500 ms later, and sends 6 more — has the consumer sent 12 req/s from the server's perspective (ratelimit tripped), or did the server reset because of the new connection? The plan does not say, and the SDK's throttle implementation will differ from the server's.
- **Evidence from the plan:** §5.4: *"Rate limit — 6 requests/sec per connection (documented). Add an `OjinClientOptions.maxRequestsPerSecond` option (default `6`, set to `Infinity` to disable) that client-side throttles `sendMessage` to avoid tripping `RATE_LIMITED` in normal operation."*
- **Recommended change:** Specify in §5.4: the throttle is per *connection instance*; it resets on every `ConnectionOpened`. If the server's limit is per-account (not per-connection), document that the SDK's throttle is a best-effort mitigation and that `RATE_LIMITED` can still fire. Alternatively, drop the throttle entirely and let the server enforce — client-side throttling adds complexity and lies to consumers about back-pressure.

### 25. Event emitter swallows handler errors silently

- **Severity:** Medium
- **Focus area:** Other (defensive review checklist §13 #8)
- **Why it matters:** `OjinEventEmitter.emit` (events.ts:54-57) wraps each callback in try/catch and `console.error`s the thrown error. §13 #8 claims: *"every `catch` block in the new code must either: rethrow, log to the injected logger at `error` level, or emit `OjinEvent.Error`."* The existing emitter does none of those three with the injected logger — it uses the raw `console.error`. This means consumer listener bugs become invisible in an embedder that has set `logger: silentLogger`.
- **Evidence from the plan:** §13 #8: *"How do you prevent the SDK from eating errors? Audit — every `catch` block in the new code must either: rethrow, log to the injected logger at `error` level, or emit `OjinEvent.Error`. A lint rule / review checklist enforces this."* Current code at `events.ts:54-57` uses `console.error`, not an injected logger.
- **Recommended change:** The emitter must be constructed with a logger reference (or given a setter). Route the try/catch through `logger.error(...)`. Add §13 #8 to the lint/test enforcement — grep for `console.` in `src/` and fail the build.

### 26. Appendix A public surface is ~50 named exports, not ~20

- **Severity:** Medium
- **Focus area:** 11 (bundle size) / 12 (ergonomics)
- **Why it matters:** The review prompt mentions "~20 named exports" but Appendix A lists closer to 50 once you count the enum variants, typed message classes, error classes, interfaces, and factories. Each one is public API the SDK must support through v2.0. In particular, the raw `serializeInteractionInputMessage` / `deserializeInteractionResponseMessage` functions at `src/index.ts:37-45` are extremely low-level — consumers who use them bypass every guarantee the SDK makes. Exposing them by default means every protocol change is a breaking change.
- **Evidence from the plan:** Appendix A enumerates: `OjinMessage`, `OjinClientMessage`, `OjinServerMessage`, 8 concrete message classes, factory, `OjinClient`, `OjinEventEmitter`, `OjinEvent` (9 variants), `ConnectionState` (5), `DisconnectReason` (7), 8 error classes, `OjinErrorCode` (~18 variants), `OjinLogger`, `OjinClientOptions`.
- **Recommended change:**
  1. Move `serializeInteractionInputMessage`/`deserializeInteractionResponseMessage` and friends to a `@ojinai/js-sdk/protocol` subpath. They are not needed by 99% of consumers.
  2. Same for `bytesToUuid` / `uuidToBytes` / `NIL_UUID` — move to `/internal` or remove from index.
  3. Same for `FPSTracker` / `LatencyTracker` (finding 15).
  4. Narrow the default index export to: the factory, `OjinClient` (constructor narrowed per finding 19), the 8 message classes, `OjinEvent`/`ConnectionState`/`DisconnectReason` enums, the error classes, `OjinErrorCode` enum, `OjinLogger` interface, `OjinClientOptions` type. That's ~25 exports, not 50.

### 27. CSP `connect-src` and `Permissions-Policy` — no guidance

- **Severity:** Low
- **Focus area:** 13 (other scars)
- **Why it matters:** A developer integrating Ojin into a site with a strict Content-Security-Policy will hit `connect-src` blocking the WebSocket URL with no error message in the SDK — just a WS `error` event with `event.type === "error"`. Same for `Permissions-Policy: microphone=()` blocking `getUserMedia` in recipes (§10.2). The plan's README structure (§10.1) has no troubleshooting section. This is low severity only because the browser's devtools will surface the CSP violation in the console; but a one-page CSP + Permissions-Policy recipe in the docs would save every integrator 30 minutes.
- **Evidence from the plan:** §10.1 README structure does not mention CSP, COEP/COOP, or Permissions-Policy. §10.2 Recipes do not include a "deploying behind strict CSP" recipe.
- **Recommended change:** Add a README subsection: "Deploying behind strict CSP" with the minimum `connect-src wss://proxy.ojin.ai` (or equivalent) and, once v2.0 ships audio, `media-src` + `Permissions-Policy: microphone=(self)`. Five lines. Pays for itself on the first Sentry ticket.

---

## Focus area coverage checkpoint

Per §4 of the prompt, every focus area must be addressed. Coverage map:

1. Timer throttling — findings 1.
2. Safari BFCache — finding 2.
3. React 18 / Strict Mode / hooks — finding 7.
4. Frame rendering path — findings 6, 9.
5. Audio jitter / lip-sync — finding 3.
6. Memory pressure — finding 9.
7. Listener/timer lifecycle — findings 17, 18, 25.
8. `Uint8Array` interop — finding 21.
9. Logger / redaction — findings 13, 14.
10. happy-dom fidelity — finding 4.
11. Bundle / tree-shaking / UMD — findings 15, 26.
12. Consumer API ergonomics — findings 5, 8, 10, 11, 12, 16, 19, 20, 22.
13. Other scars — findings 23, 24, 27.

All 13 areas have findings. No silent areas.

---

Signed,
Senior Frontend Engineer, adversarial reviewer
2026-04-17
