import { ConfigurationError } from "./errors.js";

/**
 * Configuration for exponential back-off used during live-drop reconnection.
 *
 * Distinct from `initialConnectDelayMs`, which is a *fixed* delay applied
 * between initial-connect retries (no growth — failure during initial connect
 * is more likely a misconfiguration than a transient network issue, so a
 * constant short delay surfaces the problem fast).
 *
 * The computed delay formula is:
 * `min(initialMs × multiplier^attempt, maxMs) × (1 ± jitter)`
 * where `jitter` is drawn uniformly from [−jitter, +jitter].
 *
 * See `computeBackoff` in `src/utils/backoff.ts` for the reference
 * implementation.  Defaults: 500 ms / 30 000 ms / ×2 / ±30 %.
 */
export interface ReconnectBackoff {
  /** Starting delay (ms) for the exponential-backoff curve. Default `500`. */
  initialMs: number;
  /** Hard ceiling on the computed delay (ms). Default `30_000`. */
  maxMs: number;
  /** Multiplicative growth factor per attempt. Default `2`. */
  multiplier: number;
  /**
   * Jitter fraction in [0, 1]. The computed delay varies by
   * ±(jitter × nominal). Default `0.3` (±30 %).
   */
  jitter: number;
}

/** Connection state of the OjinClient. */
export enum ConnectionState {
  Disconnected = "disconnected",
  Connecting = "connecting",
  Connected = "connected",
  Reconnecting = "reconnecting",
  Disconnecting = "disconnecting",
}

/** Configuration options for the OjinClient constructor. */
export interface OjinClientOptions {
  /** WebSocket URL of the OJIN STV service */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Configuration ID for the persona */
  configId: string;
  /** Optional mode string (e.g., "dev" for development mode) */
  mode?: string | null;
  /**
   * When `false` (default), `sendMessage` throws `ConnectionError(ServerNotReady)`
   * synchronously if the inference server is not yet ready, preserving the loud
   * throw-on-not-ready semantics of v0.1. When `true`, `sendMessage` internally
   * awaits `waitForReady(waitForReadyTimeoutMs)` before sending; messages are
   * buffered in arrival order and flushed as a batch once `session.ready` fires.
   * Default: `false`.
   */
  autoWaitForReady?: boolean;
  /**
   * Maximum time in milliseconds to wait for the inference server to become ready
   * when `autoWaitForReady` is `true`. Rejects with `ReadyTimeoutError` if the
   * timeout elapses before `session.ready` is received. Default: `10_000`.
   */
  waitForReadyTimeoutMs?: number;
  /**
   * Configuration for the pre-ready outgoing message buffer.
   * Only relevant when `autoWaitForReady` is `true`.
   */
  outgoingQueue?: {
    /**
     * Maximum number of messages to buffer while waiting for the inference
     * server to become ready. When the limit is reached, `onOverflow`
     * determines what happens. Default: `100`.
     */
    maxMessages?: number;
    /**
     * Behaviour when `maxMessages` is reached:
     * - `'reject'` (default) — rejects the `sendMessage` call immediately
     *   with `QueueFullError` carrying `details.queueDepth` and
     *   `details.maxMessages`.
     * - `'dropOldest'` — removes the oldest buffered message (its
     *   `sendMessage` Promise rejects with `QueueFullError`) and enqueues
     *   the new message in its place. Emits `OjinEvent.QueueOverflow` with
     *   `{ dropped: N }`, rate-limited to one emission per 5-second window.
     * - `'dropNewest'` — silently discards the new message; the `sendMessage`
     *   Promise resolves immediately as a no-op. Emits `OjinEvent.QueueOverflow`
     *   with `{ dropped: N }`, rate-limited to one emission per 5-second window.
     */
    onOverflow?: "reject" | "dropOldest" | "dropNewest";
  };
  /**
   * Interval between client-originated WebSocket ping frames in milliseconds.
   * Defaults to `30_000` (30 s).
   *
   * Pings are a belt-and-braces liveness hedge and are NOT load-bearing.
   * The inbound-idle check (ost-n3u7) remains the authority for liveness.
   *
   * Node.js only — the browser `WebSocket` API has no `ping()` method.
   */
  heartbeatIntervalMs?: number;
  /**
   * Maximum allowed wall-clock silence between inbound frames before the
   * connection is considered stale.
   *
   * This is evaluated from `Date.now()` against the most recent inbound frame,
   * not from a long-running timer, so it remains correct across background-tab
   * suspension and timer throttling.
   *
   * Default: `45_000`.
   */
  inboundIdleTimeoutMs?: number;
  /**
   * Maximum number of outbound messages per rolling 1-second window.
   *
   * The flashhead-lite server enforces 6 req/sec per connection; this option
   * applies client-side throttling to avoid tripping `RATE_LIMITED` in normal
   * operation.  Excess calls are buffered in the outgoing queue rather than
   * rejected.
   *
   * Set to `Infinity` to disable client-side throttling entirely.
   *
   * Default: `6`.
   */
  maxRequestsPerSecond?: number;
  /**
   * Maximum number of retry attempts during the initial `connect()` call.
   *
   * Bounds retries for the first connection only — entirely independent of
   * `maxReconnectAttempts`.  A fixed delay of `initialConnectDelayMs` is
   * applied between attempts (no exponential back-off).
   *
   * Default: `3`.
   */
  initialConnectAttempts?: number;
  /**
   * Fixed delay in milliseconds between initial-connect retry attempts.
   *
   * There is intentionally no exponential growth here — a constant short delay
   * surfaces misconfiguration quickly rather than hiding it behind growing
   * wait times.  Distinct from `reconnectBackoff.initialMs`, which seeds the
   * exponential-backoff curve used for live-drop reconnection.
   *
   * Default: `500`.
   */
  initialConnectDelayMs?: number;
  /**
   * Maximum number of reconnection attempts after an unexpected live WebSocket
   * drop.  Independent of `initialConnectAttempts` — the two counters track
   * different failure modes.
   *
   * Default: `5`.
   */
  maxReconnectAttempts?: number;
  /**
   * When `true` (default), the SDK automatically attempts to reconnect after
   * an unexpected WebSocket close using the strategy defined by
   * `reconnectBackoff`.  Set to `false` to disable automatic reconnection and
   * manage it manually.
   *
   * Default: `true`.
   */
  autoReconnect?: boolean;
  /**
   * Exponential back-off configuration for live-drop reconnection.
   *
   * Defaults: `{ initialMs: 500, maxMs: 30_000, multiplier: 2, jitter: 0.3 }`.
   * See `ReconnectBackoff` for field documentation and the `computeBackoff`
   * helper in `src/utils/backoff.ts` for the delay formula.
   */
  reconnectBackoff?: ReconnectBackoff;
}

/**
 * Throws `ConfigurationError` if any v0.1 legacy option names are present on
 * the options object passed to the `OjinClient` constructor.
 *
 * These options were removed or renamed in v1.0. The SDK does NOT silently
 * alias them because doing so would hide a 1000× unit-conversion bug
 * (`reconnectDelay` was in **seconds**; the v1.0 replacement uses
 * **milliseconds**).  Loud failure at construction is the cheap mitigation.
 *
 * @internal — called by `OjinClient` constructor before any other setup.
 */
export function assertNoLegacyOptions(options: Record<string, unknown>): void {
  if ("reconnectDelay" in options) {
    throw new ConfigurationError(
      "`reconnectDelay` was removed in v1.0. Use `reconnectBackoff.initialMs` (milliseconds, not seconds). See the migration guide.",
    );
  }
  if ("reconnectAttempts" in options) {
    throw new ConfigurationError(
      "`reconnectAttempts` was removed in v1.0. Use `initialConnectAttempts` (initial connect) or `maxReconnectAttempts` (live-drop reconnect). See the migration guide.",
    );
  }
  if ("maxQueuedMessages" in options) {
    throw new ConfigurationError(
      "`maxQueuedMessages` was removed in v1.0. Use `outgoingQueue.maxMessages`. See the migration guide.",
    );
  }
  if ("maxPendingOutgoing" in options) {
    throw new ConfigurationError(
      "`maxPendingOutgoing` was removed in v1.0. Use `outgoingQueue.maxMessages`. See the migration guide.",
    );
  }
}
