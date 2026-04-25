import {
  AuthError,
  ConfigurationError,
  ConnectionError,
  OjinError,
  OjinErrorCode,
  ProtocolError,
  QueueFullError,
  ReadyTimeoutError,
  TimeoutError,
} from "./errors.js";
import { OjinEvent, OjinEventEmitter } from "./events.js";
import {
  FrameType,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  type OjinClientMessage,
  OjinEndInteractionMessage,
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
} from "./protocol/client-messages.js";
import { mapServerError } from "./protocol/error-mapping.js";
import {
  deserializeInteractionResponseMessage,
  type ErrorResponseMessage,
} from "./protocol/interaction-messages.js";
import { MessageType } from "./protocol/session-messages.js";
import {
  assertNoLegacyOptions,
  ConnectionState,
  DisconnectReason,
  type OjinClientOptions,
  type ReconnectBackoff,
  type TextTurnWaitOptions,
} from "./types.js";
import { computeBackoff, DEFAULT_RECONNECT_BACKOFF } from "./utils/backoff.js";
import { createConsoleLogger, type OjinLogger } from "./utils/logger.js";
import { redactMeta } from "./utils/redact.js";
import { abortableSleep, scheduleTimeout, type TimeoutHandle } from "./utils/sleep.js";
import { buildConnectionUrl } from "./utils/url.js";
import { createWSTransport, type WSTransport } from "./ws-transport.js";

/** Default audio payload bytes per outbound binary frame. */
const DEFAULT_AUDIO_CHUNK_SIZE = 500_000;
/** Smallest allowed audio payload bytes per frame. */
const MIN_AUDIO_CHUNK_SIZE = 1_024;
/** Largest allowed audio payload bytes per frame. */
const MAX_AUDIO_CHUNK_SIZE = 512_000;
const NO_RETRY_CLOSE_CODES = new Set<OjinErrorCode>([
  OjinErrorCode.AuthFailed,
  OjinErrorCode.Unauthorized,
  OjinErrorCode.MissingConfigId,
  OjinErrorCode.InvalidMessage,
  OjinErrorCode.InvalidHeaders,
  OjinErrorCode.ModelNotFound,
  OjinErrorCode.FrameSizeExceeded,
]);

/**
 * An entry in the pre-ready outgoing buffer.
 *
 * When `autoWaitForReady: true`, messages sent before `session.ready` are
 * held here. The resolve/reject callbacks already incorporate cleanup of the
 * per-entry timeout timer and abort-signal listener, so they are safe to call
 * from any exit path (flush, timeout, or abort).
 */
interface PendingPreReadyMessage {
  message: OjinClientMessage;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * OjinClient — WebSocket client for communicating with the OJIN STV service.
 */
export class OjinClient {
  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly configId: string;
  private readonly mode: string | null;
  private readonly heartbeatIntervalMs: number | undefined;
  private readonly inboundIdleTimeoutMs: number;
  private readonly initialConnectAttempts: number;
  private readonly initialConnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectBackoff: Required<ReconnectBackoff>;
  private readonly audioChunkSize: number;
  private readonly logger: OjinLogger;

  /** When `true`, pre-ready `sendMessage` calls are buffered instead of thrown. */
  private readonly _autoWaitForReady: boolean;
  /** Timeout (ms) for each buffered `sendMessage` waiting for session ready. */
  private readonly _waitForReadyTimeoutMs: number;
  /** Maximum number of messages in the pre-ready buffer. */
  private readonly _preReadyQueueMax: number;
  /** Overflow policy for the pre-ready buffer. */
  private readonly _preReadyQueueOnOverflow: "reject" | "dropOldest" | "dropNewest";
  /**
   * Timestamp (ms) of the most recent `queue.overflow` emission.
   * Used to enforce the 5-second rate-limit on overflow events.
   */
  private _queueOverflowLastEmittedAt: number = 0;
  /**
   * Messages dropped since the last `queue.overflow` emission.
   * Accumulated while the rate-limit window is active; flushed to the
   * event payload on the next allowed emission.
   */
  private _queueOverflowDroppedSinceLastEmit: number = 0;
  /**
   * FIFO queue of messages waiting to be sent once the inference server
   * becomes ready. Only populated when `_autoWaitForReady` is `true`.
   */
  private _preReadyQueue: PendingPreReadyMessage[] = [];

  /**
   * Maximum outbound messages per rolling 1-second window.
   * `Infinity` disables the throttle entirely.
   */
  private readonly _maxRequestsPerSecond: number;
  /**
   * Timestamps (ms) of messages dispatched within the rolling 1-second
   * window.  Entries older than 1000 ms are pruned before each dispatch.
   *
   * NOTE (FE-review finding #24): the server's published rate limit is 6
   * req/sec **per connection**.  If the actual server-side enforcement is
   * per-account (undocumented), this client-side throttle is best-effort and
   * `RATE_LIMITED` can still fire even when the client stays within budget.
   * The retry path for server-originated RATE_LIMITED errors is in ost-v2y5
   * and is NOT implemented here.
   */
  private _throttleTimestamps: number[] = [];
  /** FIFO queue of messages waiting for a throttle slot to open. */
  private _throttlePending: Array<{
    message: OjinClientMessage;
    resolve: () => void;
    reject: (err: Error) => void;
    /** True if this entry is a RATE_LIMITED retry; preserves `_rateLimitAttempts`. */
    isRetry: boolean;
  }> = [];
  /** Handle for the next scheduled throttle-queue flush; `null` when idle. */
  private _throttleFlushTimer: TimeoutHandle | null = null;

  /**
   * The most recently dispatched outgoing message, kept as the candidate for
   * a RATE_LIMITED single-retry. Updated on every `_dispatchMessage` call.
   * Null until the first message is dispatched in a session.
   */
  private _lastDispatchedMessage: OjinClientMessage | null = null;
  /**
   * Number of RATE_LIMITED responses received for the current retry sequence.
   * 0 = no retry in progress; 1 = first RATE_LIMITED received (one retry
   * dispatched or pending). Resets to 0 on the second RATE_LIMITED (after
   * emitting OjinEvent.Error), after close(), or when a fresh non-retry
   * dispatch clears the sequence.
   */
  private _rateLimitAttempts: number = 0;
  /** True while the 200 ms abortable retry sleep is in flight. */
  private _rateLimitSleeping: boolean = false;
  /** True while a high-level text-turn helper owns the shared response waiter. */
  private _textTurnWaitInFlight = false;

  private transport: WSTransport | null = null;
  private _connectionState: ConnectionState = ConnectionState.Disconnected;
  private _inferenceServerReady = false;
  private _lastSessionReady: OjinSessionReadyMessage | null = null;
  private _lastCloseErrorCode: OjinErrorCode | null = null;
  private _lastTransportCloseCode = 1000;
  private _lastTransportCloseReason = "";
  private _consecutiveReconnectFailures = 0;
  private _reconnectLoop: Promise<void> | null = null;
  private _awaitingReconnectReady = false;
  private lastInboundAtMs = 0;
  private lastInboundPerfNowMs = 0;
  /**
   * Number of concurrent `waitForReady()` callers currently in the wait loop.
   * Drives the "emit exactly once" guarantee for `OjinEvent.WaitingForReady`:
   * the event fires when the count transitions from 0 → 1, not on every call.
   */
  private _waitingForReadyCount = 0;

  /**
   * Per-instance AbortController used to cancel in-flight sleeps, backoff
   * waits, and waitForReady calls. Re-created at the start of every connect()
   * call so a fresh signal is available. Aborted by close() before transport
   * teardown, ensuring every awaiting operation receives a deterministic
   * rejection rather than firing against a closed client.
   */
  private abortController: AbortController = new AbortController();

  /** Typed event emitter for client events. */
  readonly events: OjinEventEmitter;

  constructor(options: OjinClientOptions & { logger?: OjinLogger }) {
    assertNoLegacyOptions(options as unknown as Record<string, unknown>);
    this.wsUrl = options.wsUrl;
    this.apiKey = options.apiKey;
    this.configId = options.configId;
    this.mode = options.mode ?? null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.inboundIdleTimeoutMs = options.inboundIdleTimeoutMs ?? 45_000;
    this.initialConnectAttempts = options.initialConnectAttempts ?? 3;
    this.initialConnectDelayMs = options.initialConnectDelayMs ?? 500;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectBackoff = {
      ...DEFAULT_RECONNECT_BACKOFF,
      ...options.reconnectBackoff,
    };
    this.audioChunkSize = options.audioChunkSize ?? DEFAULT_AUDIO_CHUNK_SIZE;
    if (
      !Number.isFinite(this.audioChunkSize) ||
      this.audioChunkSize < MIN_AUDIO_CHUNK_SIZE ||
      this.audioChunkSize > MAX_AUDIO_CHUNK_SIZE
    ) {
      throw new ConfigurationError(
        `\`audioChunkSize\` must be between ${MIN_AUDIO_CHUNK_SIZE} and ${MAX_AUDIO_CHUNK_SIZE} bytes.`,
      );
    }
    this.logger = options.logger ?? createConsoleLogger("warn");
    this.events = new OjinEventEmitter(this.logger);
    this._autoWaitForReady = options.autoWaitForReady ?? false;
    this._waitForReadyTimeoutMs = options.waitForReadyTimeoutMs ?? 10_000;
    this._preReadyQueueMax = options.outgoingQueue?.maxMessages ?? 100;
    this._preReadyQueueOnOverflow = options.outgoingQueue?.onOverflow ?? "reject";
    this._maxRequestsPerSecond = options.maxRequestsPerSecond ?? 6;
    // Reset throttle budget on every new connection.  Per-connection semantics
    // mean a reconnect always starts with a full budget — not inheriting the
    // (potentially exhausted) budget from the previous transport instance
    // (FE-review finding #24).
    this.events.on(OjinEvent.ConnectionOpened, () => this._resetThrottle());
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get isServerReady(): boolean {
    return this._inferenceServerReady;
  }

  async connect(): Promise<void> {
    if (this._connectionState === ConnectionState.Connected) {
      return;
    }
    if (this._connectionState === ConnectionState.Reconnecting && this._reconnectLoop !== null) {
      await this._reconnectLoop;
      return;
    }
    if (this._connectionState === ConnectionState.Connecting) return;

    // Fresh abort controller for this connect session so any prior abort
    // signal is cleared and in-flight sleeps below can be cancelled by
    // the next close() call.
    this.abortController = new AbortController();
    this._lastCloseErrorCode = null;
    this._consecutiveReconnectFailures = 0;
    this._awaitingReconnectReady = false;
    this.lastInboundAtMs = Date.now();
    this.lastInboundPerfNowMs = this.getPerfNow();

    this.setConnectionState(ConnectionState.Connecting);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.initialConnectAttempts; attempt++) {
      try {
        await this.openTransport();
        return;
      } catch (err) {
        // Auth failures are permanent: a bad API key will never succeed on retry.
        // Surface the typed error immediately without burning additional attempts.
        if (err instanceof AuthError) {
          this.setConnectionState(ConnectionState.Disconnected);
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.initialConnectAttempts - 1) {
          try {
            await this.sleep(this.initialConnectDelayMs);
          } catch {
            // close() was called during the backoff sleep; abort signal fired.
            this.setConnectionState(ConnectionState.Disconnected);
            throw new ConnectionError("Connection attempt aborted");
          }
        }
      }
    }

    this.setConnectionState(ConnectionState.Disconnected);
    throw new ConnectionError(
      `Failed to connect after ${this.initialConnectAttempts} attempts: ${lastError?.message}`,
    );
  }

  private async openTransport(): Promise<void> {
    const url = buildConnectionUrl(
      this.wsUrl,
      this.configId,
      this.apiKey,
      this.mode === "dev" ? this.mode : null,
    );
    const headers: Record<string, string> = { Authorization: this.apiKey };
    const transport = createWSTransport({
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      logger: this.logger,
    });
    this._inferenceServerReady = false;
    this._lastSessionReady = null;
    this._lastCloseErrorCode = null;
    this.lastInboundAtMs = Date.now();
    this.lastInboundPerfNowMs = this.getPerfNow();

    transport.onMessage((data, isBinary) => {
      if (this.transport !== transport) return;
      this.handleMessage(data, isBinary);
    });

    transport.onClose((code, reason) => {
      if (this.transport !== transport) return;
      void this.handleClose(code, reason);
    });

    transport.onError((err) => {
      if (this.transport !== transport) return;
      this.logger.error("WebSocket error", { error: err.message });
    });

    this.transport = transport;

    try {
      await transport.connect(url, headers);
      transport.setNoDelay();
    } catch (err) {
      if (this.transport === transport) {
        this.transport = null;
      }
      throw err;
    }
    this.setConnectionState(ConnectionState.Connected);
    this.events.emit(OjinEvent.ConnectionOpened);
  }

  async close(): Promise<void> {
    if (this._connectionState === ConnectionState.Disconnected) {
      return;
    }
    const previousState = this._connectionState;
    const shouldEmitClosed =
      previousState === ConnectionState.Connected ||
      previousState === ConnectionState.Connecting ||
      previousState === ConnectionState.Reconnecting;

    // Abort BEFORE transport teardown so every in-flight sleep, backoff wait,
    // and waitForReady call receives a deterministic rejection rather than
    // hanging until its own timeout fires (FE-review finding 18).
    this.abortController.abort();

    this.setConnectionState(ConnectionState.Disconnecting);
    this._inferenceServerReady = false;
    this._lastSessionReady = null;
    this._lastCloseErrorCode = null;
    this._consecutiveReconnectFailures = 0;
    this._awaitingReconnectReady = false;
    this.rejectPendingThrottleQueue(
      new ConnectionError(
        "Connection closed while message was throttled",
        OjinErrorCode.NotConnected,
      ),
    );
    this.resetRateLimitRetryState();

    this.transport?.close();
    this.transport = null;
    if (shouldEmitClosed) {
      this.emitConnectionClosed(1000, "", DisconnectReason.ClientInitiated);
    }

    this.setConnectionState(ConnectionState.Disconnected);
  }

  /**
   * Resolves when the inference server signals it is ready to accept messages
   * (`SessionReady` event), or immediately if it is already ready.
   *
   * Rejects with `ConnectionError(NotConnected)` if `close()` is called before
   * the server becomes ready, and rejects with `ReadyTimeoutError` (carrying
   * `details.configId`, `details.elapsedMs`, and `details.lastConnectionState`)
   * if `timeoutMs` elapses first.
   *
   * Emits `OjinEvent.WaitingForReady` exactly once when the first concurrent
   * caller enters the wait — not once per concurrent caller. This gives UIs a
   * one-shot signal to render a spinner (FE-review finding 5).
   *
   * The wait is tied to the same per-instance `AbortController` used by the
   * reconnect backoff sleeps, so a concurrent `close()` always rejects this
   * promise deterministically (FE-review finding 18).
   *
   * @param timeoutMs - Maximum wait in milliseconds (default: 10 000).
   */
  async waitForReady(timeoutMs = 10_000): Promise<OjinSessionReadyMessage> {
    if (this._lastSessionReady !== null) {
      return this._lastSessionReady;
    }

    const { signal } = this.abortController;
    const startMs = Date.now();

    // Fast-path: if close() was already called before we entered, reject
    // immediately without emitting WaitingForReady (prevents a spurious
    // spinner flash followed immediately by NotConnected — finding-5).
    if (signal.aborted) {
      return Promise.reject(
        new ConnectionError(
          "Connection closed while waiting for session ready",
          OjinErrorCode.NotConnected,
        ),
      );
    }

    // Emit `session.waiting_for_ready` exactly once when the first concurrent
    // waiter enters — not once per caller. The count is decremented in every
    // exit path (resolve, reject-on-abort, reject-on-timeout).
    if (this._waitingForReadyCount === 0) {
      this.events.emit(OjinEvent.WaitingForReady, { configId: this.configId, elapsedMs: 0 });
    }
    this._waitingForReadyCount++;

    return new Promise<OjinSessionReadyMessage>((resolve, reject) => {
      let timer: TimeoutHandle | null = null;

      const cleanup = () => {
        this._waitingForReadyCount--;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal.removeEventListener("abort", onAbort);
        this.events.off(OjinEvent.SessionReady, onReady);
      };

      const onReady = (msg: OjinSessionReadyMessage) => {
        cleanup();
        resolve(msg);
      };

      const onAbort = () => {
        cleanup();
        reject(
          new ConnectionError(
            "Connection closed while waiting for session ready",
            OjinErrorCode.NotConnected,
          ),
        );
      };

      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = scheduleTimeout(() => {
          cleanup();
          const elapsedMs = Date.now() - startMs;
          reject(
            new ReadyTimeoutError(
              OjinErrorCode.ReadyTimeout,
              `Timed out waiting for session ready after ${timeoutMs}ms`,
              {
                configId: this.configId,
                elapsedMs,
                lastConnectionState: this._connectionState,
              },
            ),
          );
        }, timeoutMs);
      }

      signal.addEventListener("abort", onAbort, { once: true });
      this.events.on(OjinEvent.SessionReady, onReady);
    });
  }

  /**
   * Send a text input message to the persona.
   *
   * Convenience wrapper around
   * `sendMessage(new OjinTextInputMessage(text, params))`.
   *
   * @param text - The text to send.
   * @param params - Optional parameters forwarded to the interaction payload.
   */
  async sendText(text: string, params?: Record<string, unknown>): Promise<void> {
    return this.sendMessage(new OjinTextInputMessage(text, params));
  }

  /**
   * Send a complete text turn to the persona.
   *
   * Convenience wrapper that sends the text input message followed by
   * `endInteraction()`. Use `sendText()` or `sendMessage(...)` directly when
   * you need finer-grained control over turn boundaries.
   *
   * @param text - The text to send.
   * @param params - Optional parameters forwarded to the interaction payload.
   */
  async sendTextTurn(text: string, params?: Record<string, unknown>): Promise<void> {
    await this.sendText(text, params);
    await this.endInteraction();
  }

  /**
   * Send a complete text turn and resolve when its terminal speech frame
   * arrives (`isFinalResponse: true`).
   *
   * This helper is intended for the common "send one text prompt and wait
   * until the turn is finished" flow. Low-level streaming consumers should
   * continue to use `sendTextTurn()` plus `OjinEvent.InteractionResponse`.
   *
   * The helper ignores idle frames and waits for the next speech interaction
   * that begins after this call starts listening. Once the first speech frame
   * arrives, subsequent frames are matched by `interactionId` until the final
   * frame for that interaction is received.
   */
  async sendTextTurnAndWait(
    text: string,
    params?: Record<string, unknown>,
    options?: TextTurnWaitOptions,
  ): Promise<OjinInteractionResponseMessage> {
    if (this._textTurnWaitInFlight) {
      throw new ConfigurationError(
        "High-level text turn helpers do not support concurrent calls on the same client.",
      );
    }

    this._textTurnWaitInFlight = true;
    try {
      await this.waitForReady(options?.readyTimeoutMs ?? this._waitForReadyTimeoutMs);

      const pending = this.waitForFinalSpeechResponse(options?.responseTimeoutMs ?? 15_000);
      try {
        await this.sendTextTurn(text, params);
        return await pending.promise;
      } finally {
        pending.cleanup();
      }
    } finally {
      this._textTurnWaitInFlight = false;
    }
  }

  /**
   * Send a complete text turn and yield each speech frame for that turn.
   *
   * This helper provides a per-turn async iterator on top of the global
   * `interactionResponse` event stream. Idle frames are ignored. The iterator
   * binds to the first speech `interactionId` that arrives after the turn is
   * sent, yields frames for that interaction in arrival order, and completes
   * after the terminal frame (`isFinalResponse: true`) is yielded.
   */
  async *streamTextTurn(
    text: string,
    params?: Record<string, unknown>,
    options?: TextTurnWaitOptions,
  ): AsyncGenerator<OjinInteractionResponseMessage, void, void> {
    if (this._textTurnWaitInFlight) {
      throw new ConfigurationError(
        "High-level text turn helpers do not support concurrent calls on the same client.",
      );
    }

    this._textTurnWaitInFlight = true;
    try {
      await this.waitForReady(options?.readyTimeoutMs ?? this._waitForReadyTimeoutMs);

      const stream = this.createSpeechResponseStream(options?.responseTimeoutMs ?? 15_000);
      try {
        await this.sendTextTurn(text, params);
        while (true) {
          const next = await stream.iterator.next();
          if (next.done) {
            return;
          }
          yield next.value;
        }
      } finally {
        await stream.iterator.return?.();
        stream.cleanup();
      }
    } finally {
      this._textTurnWaitInFlight = false;
    }
  }

  /**
   * Send a raw PCM audio input message to the persona.
   *
   * Convenience wrapper around
   * `sendMessage(new OjinAudioInputMessage(pcm, params))`.
   *
   * @param pcm - Raw 16-bit PCM audio bytes.
   * @param params - Optional parameters forwarded to the interaction payload.
   */
  async sendAudio(pcm: Uint8Array, params?: Record<string, unknown>): Promise<void> {
    return this.sendMessage(new OjinAudioInputMessage(pcm, params));
  }

  /**
   * Interrupt the current in-progress interaction.
   *
   * Convenience wrapper around
   * `sendMessage(new OjinCancelInteractionMessage())`.
   */
  async interrupt(): Promise<void> {
    return this.sendMessage(new OjinCancelInteractionMessage());
  }

  /**
   * End the current interaction gracefully.
   *
   * Convenience wrapper around
   * `sendMessage(new OjinEndInteractionMessage())`.
   */
  async endInteraction(): Promise<void> {
    return this.sendMessage(new OjinEndInteractionMessage());
  }

  async sendMessage(message: OjinClientMessage): Promise<void> {
    // Transport must be open regardless of autoWaitForReady.
    if (!this.transport?.isOpen || this._connectionState !== ConnectionState.Connected) {
      throw new ConnectionError("Not connected to OJIN STV service");
    }

    if (!this._inferenceServerReady) {
      if (!this._autoWaitForReady) {
        // Default: preserve v0.1 loud-throw semantics.
        throw new ConnectionError(
          "Inference Server is not ready to receive messages",
          OjinErrorCode.ServerNotReady,
        );
      }
      // autoWaitForReady: true — buffer until session.ready fires.
      return this._enqueueAndWaitForReady(message);
    }

    return this._throttledDispatch(message);
  }

  /**
   * Dispatch a message directly over the transport. The caller is responsible
   * for ensuring the server is ready before calling this method.
   *
   * @param isRetry - When `true` this call is a RATE_LIMITED retry; the
   *   `_rateLimitAttempts` counter is left intact so a second RATE_LIMITED
   *   response triggers the error path instead of starting another retry loop.
   */
  private _dispatchMessage(message: OjinClientMessage, isRetry = false): void {
    this._lastDispatchedMessage = message;
    if (!isRetry) {
      // A fresh non-retry dispatch ends any prior rate-limit retry sequence so
      // the next RATE_LIMITED response gets a fresh single-retry opportunity.
      this._rateLimitAttempts = 0;
    }
    if (message instanceof OjinCancelInteractionMessage) {
      const cancelMsg = {
        type: MessageType.CancelInteraction,
        payload: message.toMessage() as Record<string, unknown>,
      };
      this.wsSend(JSON.stringify(cancelMsg));
      return;
    }

    if (message instanceof OjinAudioInputMessage) {
      this.chunkAndSendAudio(message);
      return;
    }

    if (message instanceof OjinTextInputMessage) {
      this.wsSend(message.toBytes());
      return;
    }

    if (message instanceof OjinEndInteractionMessage) {
      this.wsSend(JSON.stringify(message.toMessage()));
      return;
    }

    throw new ProtocolError(`Unknown message type: ${message.constructor.name}`);
  }

  /**
   * Enqueue `message` in the pre-ready buffer and return a Promise that
   * resolves when the message is flushed (on `session.ready`) or rejects on
   * timeout or connection close.
   *
   * Overflow is handled according to `_preReadyQueueOnOverflow` before the
   * Promise is created, so callers never observe a race between the overflow
   * check and the enqueue.
   */
  private _enqueueAndWaitForReady(message: OjinClientMessage): Promise<void> {
    // Handle overflow before creating a promise so the response is immediate.
    if (this._preReadyQueue.length >= this._preReadyQueueMax) {
      switch (this._preReadyQueueOnOverflow) {
        case "dropNewest":
          // Discard the incoming message; emit a rate-limited overflow event.
          this._emitQueueOverflow(1);
          return Promise.resolve();
        case "dropOldest": {
          // Eject the oldest entry and enqueue the new message in its place.
          const oldest = this._preReadyQueue.shift();
          if (oldest) {
            oldest.reject(
              new QueueFullError(
                OjinErrorCode.QueueFull,
                "Pre-ready buffer overflow: oldest message dropped",
              ),
            );
          }
          this._emitQueueOverflow(1);
          break; // fall through to enqueue the new message
        }
        default: // 'reject'
          return Promise.reject(
            new QueueFullError(
              OjinErrorCode.QueueFull,
              `Pre-ready buffer full (max ${this._preReadyQueueMax} messages)`,
              { queueDepth: this._preReadyQueue.length, maxMessages: this._preReadyQueueMax },
            ),
          );
      }
    }

    return new Promise<void>((resolve, reject) => {
      const { signal } = this.abortController;
      let timer: TimeoutHandle | null = null;
      // Forward-declared so cleanup() and onAbort() can reference each other.
      let onAbort!: () => void;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal.removeEventListener("abort", onAbort);
      };

      const entry: PendingPreReadyMessage = {
        message,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };

      onAbort = () => {
        const idx = this._preReadyQueue.indexOf(entry);
        if (idx !== -1) this._preReadyQueue.splice(idx, 1);
        entry.reject(
          new ConnectionError(
            "Connection closed while waiting for session ready",
            OjinErrorCode.NotConnected,
          ),
        );
      };

      // Fast-path: already aborted (close() was called before we got here).
      if (signal.aborted) {
        onAbort();
        return;
      }

      const timeoutMs = this._waitForReadyTimeoutMs;
      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = scheduleTimeout(() => {
          const idx = this._preReadyQueue.indexOf(entry);
          if (idx !== -1) this._preReadyQueue.splice(idx, 1);
          entry.reject(
            new ReadyTimeoutError(
              OjinErrorCode.ReadyTimeout,
              `sendMessage timed out waiting for session ready after ${timeoutMs}ms`,
              {
                configId: this.configId,
                elapsedMs: timeoutMs,
                lastConnectionState: this._connectionState,
              },
            ),
          );
        }, timeoutMs);
      }

      signal.addEventListener("abort", onAbort, { once: true });
      this._preReadyQueue.push(entry);
    });
  }

  /**
   * Flush the pre-ready buffer in arrival order once the inference server
   * signals it is ready. Each buffered message is dispatched synchronously;
   * its Promise resolves (or rejects on dispatch error) before moving to the
   * next entry.
   */
  private _flushPreReadyQueue(): void {
    // Drain atomically so any concurrent sendMessage call that races against
    // this flush sees an empty queue and goes through the fast path.
    const queue = this._preReadyQueue.splice(0);
    for (const entry of queue) {
      try {
        this._dispatchMessage(entry.message);
        entry.resolve();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  isConnected(): boolean {
    return this.transport?.isOpen ?? false;
  }

  private waitForFinalSpeechResponse(responseTimeoutMs: number): {
    cleanup: () => void;
    promise: Promise<OjinInteractionResponseMessage>;
  } {
    const startMs = Date.now();
    let timeout: TimeoutHandle | null = null;
    let interactionId: string | null = null;
    let settled = false;
    let offResponse: (() => void) | null = null;
    let offError: (() => void) | null = null;
    let offClosed: (() => void) | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      offResponse?.();
      offError?.();
      offClosed?.();
    };

    const promise = new Promise<OjinInteractionResponseMessage>((resolve, reject) => {
      offResponse = this.events.on(OjinEvent.InteractionResponse, (message) => {
        if (message.frameType !== FrameType.Speech) {
          return;
        }
        if (interactionId === null) {
          interactionId = message.interactionId;
        }
        if (message.interactionId !== interactionId || !message.isFinalResponse) {
          return;
        }
        cleanup();
        resolve(message);
      });

      offError = this.events.on(OjinEvent.Error, (error) => {
        cleanup();
        reject(error);
      });

      offClosed = this.events.on(
        OjinEvent.ConnectionClosed,
        ({ code, reason, disconnectReason }) => {
          cleanup();
          reject(
            new ConnectionError(
              "Connection closed while waiting for the final interaction response",
              OjinErrorCode.NotConnected,
              {
                code,
                reason,
                disconnectReason,
                elapsedMs: Date.now() - startMs,
                interactionId,
              },
            ),
          );
        },
      );

      if (responseTimeoutMs > 0 && responseTimeoutMs !== Infinity) {
        timeout = scheduleTimeout(() => {
          cleanup();
          reject(
            new TimeoutError(
              OjinErrorCode.Timeout,
              `Timed out waiting for the final interaction response after ${responseTimeoutMs}ms`,
              {
                responseTimeoutMs,
                elapsedMs: Date.now() - startMs,
                lastConnectionState: this._connectionState,
                interactionId,
              },
            ),
          );
        }, responseTimeoutMs);
      }
    });

    return { cleanup, promise };
  }

  private createSpeechResponseStream(responseTimeoutMs: number): {
    cleanup: () => void;
    iterator: AsyncGenerator<OjinInteractionResponseMessage, void, void>;
  } {
    const startMs = Date.now();
    const queue: OjinInteractionResponseMessage[] = [];
    let timeout: TimeoutHandle | null = null;
    let interactionId: string | null = null;
    let completed = false;
    let failure: Error | null = null;
    let resume: ((result: IteratorResult<OjinInteractionResponseMessage, void>) => void) | null =
      null;
    let resumeError: ((error: Error) => void) | null = null;
    let offResponse: (() => void) | null = null;
    let offError: (() => void) | null = null;
    let offClosed: (() => void) | null = null;

    const clearListeners = () => {
      offResponse?.();
      offError?.();
      offClosed?.();
      offResponse = null;
      offError = null;
      offClosed = null;
    };

    const clearTimeoutIfSet = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const settlePendingIfPossible = () => {
      if (resume === null) {
        return;
      }
      if (failure !== null) {
        const reject = resumeError;
        resume = null;
        resumeError = null;
        reject?.(failure);
        return;
      }
      if (queue.length > 0) {
        const resolve = resume;
        const next = queue.shift();
        resume = null;
        resumeError = null;
        if (next) {
          resolve({ value: next, done: false });
        }
        return;
      }
      if (completed) {
        const resolve = resume;
        resume = null;
        resumeError = null;
        resolve({ value: undefined, done: true });
      }
    };

    const cleanup = () => {
      completed = true;
      clearTimeoutIfSet();
      clearListeners();
      settlePendingIfPossible();
    };

    const fail = (error: Error) => {
      if (completed || failure !== null) {
        return;
      }
      failure = error;
      completed = true;
      clearTimeoutIfSet();
      clearListeners();
      settlePendingIfPossible();
    };

    const finish = () => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeoutIfSet();
      clearListeners();
      settlePendingIfPossible();
    };

    const scheduleResponseTimeout = () => {
      clearTimeoutIfSet();
      if (responseTimeoutMs <= 0 || responseTimeoutMs === Infinity) {
        return;
      }
      timeout = scheduleTimeout(() => {
        fail(
          new TimeoutError(
            OjinErrorCode.Timeout,
            `Timed out waiting for the next interaction response after ${responseTimeoutMs}ms`,
            {
              responseTimeoutMs,
              elapsedMs: Date.now() - startMs,
              lastConnectionState: this._connectionState,
              interactionId,
            },
          ),
        );
      }, responseTimeoutMs);
    };

    offResponse = this.events.on(OjinEvent.InteractionResponse, (message) => {
      if (message.frameType !== FrameType.Speech) {
        return;
      }
      if (interactionId === null) {
        interactionId = message.interactionId;
      }
      if (message.interactionId !== interactionId) {
        return;
      }

      queue.push(message);
      if (message.isFinalResponse) {
        finish();
      } else {
        scheduleResponseTimeout();
      }
      settlePendingIfPossible();
    });

    offError = this.events.on(OjinEvent.Error, (error) => {
      fail(error);
    });

    offClosed = this.events.on(OjinEvent.ConnectionClosed, ({ code, reason, disconnectReason }) => {
      fail(
        new ConnectionError(
          "Connection closed while streaming the interaction response",
          OjinErrorCode.NotConnected,
          {
            code,
            reason,
            disconnectReason,
            elapsedMs: Date.now() - startMs,
            interactionId,
          },
        ),
      );
    });

    scheduleResponseTimeout();

    const iterator = (async function* (
      nextFrame: () => Promise<IteratorResult<OjinInteractionResponseMessage, void>>,
      stop: () => void,
    ): AsyncGenerator<OjinInteractionResponseMessage, void, void> {
      try {
        while (true) {
          const next = await nextFrame();
          if (next.done) {
            return;
          }
          yield next.value;
        }
      } finally {
        stop();
      }
    })(() => {
      if (failure !== null) {
        return Promise.reject(failure);
      }
      if (queue.length > 0) {
        const next = queue.shift();
        if (next) {
          return Promise.resolve({ value: next, done: false } as const);
        }
      }
      if (completed) {
        return Promise.resolve({ value: undefined, done: true } as const);
      }
      return new Promise<IteratorResult<OjinInteractionResponseMessage, void>>(
        (resolve, reject) => {
          resume = resolve;
          resumeError = reject;
        },
      );
    }, cleanup);

    return { cleanup, iterator };
  }

  // ── Throttle helpers ────────────────────────────────────────────────────────

  /**
   * Dispatch `message` with rate-limiting applied.
   *
   * If `_maxRequestsPerSecond` is `Infinity` the message is dispatched
   * synchronously with no bookkeeping.  Otherwise, if budget remains in the
   * rolling 1-second window the message is dispatched immediately; when the
   * budget is exhausted the message is pushed onto `_throttlePending` and the
   * returned Promise resolves once the message is eventually dispatched (or
   * rejects if the connection closes in the interim).
   */
  private _throttledDispatch(message: OjinClientMessage, isRetry = false): Promise<void> {
    if (this._maxRequestsPerSecond === Infinity) {
      this._dispatchMessage(message, isRetry);
      return Promise.resolve();
    }

    const now = Date.now();
    this._pruneThrottleWindow(now);

    if (this._throttleTimestamps.length < this._maxRequestsPerSecond) {
      // Budget available — send immediately and record the timestamp.
      this._throttleTimestamps.push(now);
      this._dispatchMessage(message, isRetry);
      return Promise.resolve();
    }

    // Budget exhausted — enqueue for deferred dispatch.
    return new Promise<void>((resolve, reject) => {
      this._throttlePending.push({ message, resolve, reject, isRetry });
      this._scheduleThrottleFlush();
    });
  }

  /**
   * Remove timestamps outside the rolling 1-second window from
   * `_throttleTimestamps` so the window always reflects only the last 1 000 ms.
   */
  private _pruneThrottleWindow(now: number): void {
    const cutoff = now - 1000;
    while (this._throttleTimestamps.length > 0 && this._throttleTimestamps[0] <= cutoff) {
      this._throttleTimestamps.shift();
    }
  }

  /**
   * Schedule a `_flushThrottleQueue` call for when the oldest in-window
   * timestamp expires (i.e., when the next throttle slot opens).
   * No-op if a flush is already scheduled.
   */
  private _scheduleThrottleFlush(): void {
    if (this._throttleFlushTimer !== null) return;
    if (this._throttleTimestamps.length === 0) return;

    // +1 ms so the boundary itself is safely past when the timer fires.
    const delay = Math.max(0, this._throttleTimestamps[0] + 1000 - Date.now() + 1);
    this._throttleFlushTimer = scheduleTimeout(() => {
      this._throttleFlushTimer = null;
      this._flushThrottleQueue();
    }, delay);
  }

  /**
   * Send as many queued messages as the current throttle budget allows, then
   * re-schedule if there are still messages waiting.
   */
  private _flushThrottleQueue(): void {
    if (this._throttlePending.length === 0) return;

    const now = Date.now();
    this._pruneThrottleWindow(now);

    while (
      this._throttlePending.length > 0 &&
      this._throttleTimestamps.length < this._maxRequestsPerSecond
    ) {
      const entry = this._throttlePending.shift();
      if (!entry) break;
      this._throttleTimestamps.push(Date.now());
      try {
        this._dispatchMessage(entry.message, entry.isRetry);
        entry.resolve();
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      // Re-prune in case several milliseconds passed during dispatch.
      this._pruneThrottleWindow(Date.now());
    }

    if (this._throttlePending.length > 0) {
      this._scheduleThrottleFlush();
    }
  }

  // ── Queue overflow helpers ──────────────────────────────────────────────────

  /**
   * Emit `OjinEvent.QueueOverflow` with the accumulated drop count, subject to
   * a 5-second emission rate-limit. Drops occurring within an active window
   * are accumulated and included in the next permitted emission.
   *
   * @param dropped - Number of messages dropped by this single overflow event.
   */
  private _emitQueueOverflow(dropped: number): void {
    this._queueOverflowDroppedSinceLastEmit += dropped;
    const now = Date.now();
    if (now - this._queueOverflowLastEmittedAt < 5_000) return;
    const total = this._queueOverflowDroppedSinceLastEmit;
    this._queueOverflowDroppedSinceLastEmit = 0;
    this._queueOverflowLastEmittedAt = now;
    this.events.emit(OjinEvent.QueueOverflow, { dropped: total });
  }

  /**
   * Reset the throttle budget to empty.
   *
   * Called on every `connection.opened` event so that each new transport
   * connection starts with a full budget (per-connection semantics, not
   * session-lifetime — FE-review finding #24).  Any messages that were queued
   * before the reconnect are immediately eligible for dispatch on the fresh
   * connection.
   */
  private _resetThrottle(): void {
    this._throttleTimestamps = [];
    if (this._throttleFlushTimer !== null) {
      clearTimeout(this._throttleFlushTimer);
      this._throttleFlushTimer = null;
    }
    if (this._inferenceServerReady) {
      this._flushThrottleQueue();
    }
  }

  /**
   * Handle a server-originated `RATE_LIMITED` error with a single retry.
   *
   * On the **first** `RATE_LIMITED`, the most-recently-dispatched message is
   * re-queued for retry after a 200 ms abortable sleep (ost-v2y5 AC#1).
   * Re-queuing goes through `_throttledDispatch` so the throttle budget is
   * re-checked before the retry is actually transmitted (AC#2).
   *
   * On a **second** `RATE_LIMITED` for the same retry, `OjinEvent.Error` is
   * emitted and the retry sequence resets — one retry only (AC#3).
   *
   * The 200 ms sleep uses the shared abortable `sleep` helper so a concurrent
   * `close()` cancels the delay cleanly with no late error events (AC#4).
   *
   * Only one concurrent retry sleep is allowed. A `RATE_LIMITED` that arrives
   * while a sleep is already in flight is surfaced immediately as an error
   * (thundering-herd guard).
   */
  private _handleRateLimited(serverMessage: string, details?: unknown): void {
    // Guard: connection teardown in progress — swallow to prevent late events.
    if (this.abortController.signal.aborted) return;

    // Only one concurrent retry sleep is permitted.
    if (this._rateLimitSleeping) {
      this.events.emit(
        OjinEvent.Error,
        mapServerError(OjinErrorCode.RateLimited, serverMessage, details),
      );
      return;
    }

    if (this._rateLimitAttempts === 0) {
      // First RATE_LIMITED: schedule a single retry after 200 ms.
      const candidate = this._lastDispatchedMessage;
      if (candidate === null) {
        // Nothing to retry — surface the error immediately.
        this.events.emit(
          OjinEvent.Error,
          mapServerError(OjinErrorCode.RateLimited, serverMessage, details),
        );
        return;
      }

      this._rateLimitAttempts = 1;
      this._rateLimitSleeping = true;

      void this.sleep(200)
        .then(() => {
          this._rateLimitSleeping = false;
          // Re-queue through the throttle so the budget is re-checked before
          // transmission.  isRetry=true keeps _rateLimitAttempts at 1 so that
          // a second RATE_LIMITED triggers the error path instead of another
          // retry loop.
          void this._throttledDispatch(candidate, true).catch(() => {
            // Dispatch failed (connection closed during re-queue) — reset silently.
            this._rateLimitAttempts = 0;
          });
        })
        .catch(() => {
          // close() fired during the 200 ms sleep — cancel cleanly, no error event.
          this._rateLimitSleeping = false;
          this._rateLimitAttempts = 0;
        });

      return; // Suppress OjinEvent.Error on the first RATE_LIMITED.
    }

    // Second RATE_LIMITED (for the retry): emit error and reset the sequence.
    this._rateLimitAttempts = 0;
    this.events.emit(
      OjinEvent.Error,
      mapServerError(OjinErrorCode.RateLimited, serverMessage, details),
    );
  }

  private resetRateLimitRetryState(): void {
    this._rateLimitAttempts = 0;
    this._rateLimitSleeping = false;
    this._lastDispatchedMessage = null;
  }

  private rejectPendingThrottleQueue(error: ConnectionError): void {
    if (this._throttleFlushTimer !== null) {
      clearTimeout(this._throttleFlushTimer);
      this._throttleFlushTimer = null;
    }
    for (const entry of this._throttlePending.splice(0)) {
      entry.reject(error);
    }
  }

  private noteInboundFrame(): void {
    const previousInboundAtMs = this.lastInboundAtMs;
    const previousPerfNowMs = this.lastInboundPerfNowMs;
    const wasStale =
      previousInboundAtMs > 0 && this.isInboundStale() && this.logger.isLevelEnabled("debug");
    const now = Date.now();
    const perfNow = this.getPerfNow();

    if (wasStale) {
      this.logger.debug("Inbound stream resumed after idle gap", {
        idleMs: now - previousInboundAtMs,
        perfDriftMs:
          previousPerfNowMs > 0
            ? Math.round(now - previousInboundAtMs - (perfNow - previousPerfNowMs))
            : 0,
      });
    }

    this.lastInboundAtMs = now;
    this.lastInboundPerfNowMs = perfNow;
  }

  private isInboundStale(): boolean {
    return Date.now() - this.lastInboundAtMs > this.inboundIdleTimeoutMs;
  }

  private emitConnectionClosed(
    code: number,
    reason: string,
    disconnectReason: DisconnectReason,
  ): void {
    this.events.emit(OjinEvent.ConnectionClosed, { code, reason, disconnectReason });
  }

  private emitLastCloseWithReason(disconnectReason: DisconnectReason): void {
    this.emitConnectionClosed(
      this._lastTransportCloseCode,
      this._lastTransportCloseReason,
      disconnectReason,
    );
  }

  private classifyDisconnectReason(userInitiated: boolean): DisconnectReason {
    if (userInitiated) {
      return DisconnectReason.ClientInitiated;
    }
    if (this.hasNoRetryCloseCode()) {
      return DisconnectReason.AuthenticationFailed;
    }
    if (this.isInboundStale()) {
      return DisconnectReason.ConnectionLost;
    }
    if (this._lastCloseErrorCode !== null) {
      return DisconnectReason.ServerInitiated;
    }
    return DisconnectReason.Unknown;
  }

  private hasNoRetryCloseCode(): boolean {
    return this._lastCloseErrorCode !== null && NO_RETRY_CLOSE_CODES.has(this._lastCloseErrorCode);
  }

  private startReconnectLoop(): void {
    if (this._reconnectLoop !== null) return;
    const reconnectLoop = this.runReconnectLoop().finally(() => {
      if (this._reconnectLoop === reconnectLoop) {
        this._reconnectLoop = null;
      }
    });
    this._reconnectLoop = reconnectLoop;
  }

  private async runReconnectLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      if (this._consecutiveReconnectFailures >= this.maxReconnectAttempts) {
        const error = new ConnectionError(
          `Failed to reconnect after ${this.maxReconnectAttempts} attempts`,
          OjinErrorCode.ReconnectFailed,
        );
        this.emitLastCloseWithReason(DisconnectReason.ReconnectFailed);
        this.handleTerminalDisconnect(error);
        this.events.emit(OjinEvent.Error, error);
        return;
      }

      const attempt = this._consecutiveReconnectFailures + 1;
      const delayMs = Math.round(computeBackoff(attempt - 1, this.reconnectBackoff));
      this.setConnectionState(ConnectionState.Reconnecting);
      this.events.emit(OjinEvent.Reconnecting, { attempt, delayMs });

      try {
        await this.sleep(delayMs);
      } catch {
        this.setConnectionState(ConnectionState.Disconnected);
        return;
      }

      try {
        await this.openTransport();
      } catch (err) {
        if (err instanceof AuthError) {
          this.emitLastCloseWithReason(DisconnectReason.AuthenticationFailed);
          this.handleTerminalDisconnect(err);
          this.events.emit(OjinEvent.Error, err);
          return;
        }
        this._consecutiveReconnectFailures++;
        continue;
      }

      this._awaitingReconnectReady = !this._inferenceServerReady;
      this.events.emit(OjinEvent.Reconnected);
      return;
    }

    this.setConnectionState(ConnectionState.Disconnected);
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.events.emit(OjinEvent.ConnectionStateChanged, state);
  }

  private handleMessage(data: Uint8Array, isBinary: boolean): void {
    try {
      this.noteInboundFrame();

      if (isBinary) {
        this._lastCloseErrorCode = null;
        try {
          const responseMsg = deserializeInteractionResponseMessage(data);
          const ojinResponse = OjinInteractionResponseMessage.fromProxyMessage(responseMsg);
          this.events.emit(OjinEvent.InteractionResponse, ojinResponse);
        } catch (err) {
          this.logger.error("Error parsing binary response", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      const text = new TextDecoder().decode(data);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        this._lastCloseErrorCode = null;
        const err = new ProtocolError(text, { rawMessage: text });
        this.events.emit(OjinEvent.Error, err);
        return;
      }

      const msgType = parsed.type as string;

      if (this.logger.isLevelEnabled("debug")) {
        this.logger.debug("Received message", redactMeta({ type: msgType }));
      }

      if (msgType === MessageType.SessionReady) {
        const payload = (parsed.payload ?? {}) as Record<string, unknown>;
        const sessionReady = new OjinSessionReadyMessage(
          (payload.parameters as Record<string, unknown>) ?? null,
        );
        this._inferenceServerReady = true;
        this._lastSessionReady = sessionReady;
        this._lastCloseErrorCode = null;
        this._awaitingReconnectReady = false;
        this._consecutiveReconnectFailures = 0;
        this.events.emit(OjinEvent.SessionReady, sessionReady);
        // Flush pre-ready buffer in arrival order now that the server is ready.
        this._flushPreReadyQueue();
        this._flushThrottleQueue();
        return;
      }

      if (msgType === MessageType.SessionPing) {
        this._lastCloseErrorCode = null;
        return;
      }

      if (msgType === MessageType.ErrorResponse) {
        const errorMsg = parsed as unknown as ErrorResponseMessage;
        const { code, message, details } = errorMsg.payload;
        this._lastCloseErrorCode = code as OjinErrorCode;

        if (code === OjinErrorCode.Cancelled) {
          if (this.logger.isLevelEnabled("debug")) {
            this.logger.debug("Interaction cancelled by server", { code });
          }
          return;
        }

        if (code === OjinErrorCode.RateLimited) {
          this._handleRateLimited(message, details ?? undefined);
          return;
        }

        const error = mapServerError(code, message, details ?? undefined);
        this.events.emit(OjinEvent.Error, error);
        return;
      }

      if (msgType === MessageType.InteractionResponse) {
        this._lastCloseErrorCode = null;
        this.logger.warn("Received text-based interaction response, expected binary");
        return;
      }

      this._lastCloseErrorCode = null;
      this.logger.warn("Unknown message type", { type: msgType });
    } catch (err) {
      this.logger.error("Error handling message", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleClose(code: number, reason: string): Promise<void> {
    const previousState = this._connectionState;
    const wasConnected = previousState === ConnectionState.Connected;
    const userInitiated =
      previousState === ConnectionState.Disconnecting || this.abortController.signal.aborted;
    const shouldRetry =
      wasConnected && !userInitiated && this.autoReconnect && !this.hasNoRetryCloseCode();
    const hadReadySinceOpen = this._inferenceServerReady || this._lastSessionReady !== null;
    const disconnectReason = this.classifyDisconnectReason(userInitiated);
    this._lastTransportCloseCode = code;
    this._lastTransportCloseReason = reason;

    this.transport = null;
    this._inferenceServerReady = false;
    this._lastSessionReady = null;
    if (this._throttleFlushTimer !== null) {
      clearTimeout(this._throttleFlushTimer);
      this._throttleFlushTimer = null;
    }
    this.resetRateLimitRetryState();

    if (hadReadySinceOpen) {
      this._consecutiveReconnectFailures = 0;
    } else if (this._awaitingReconnectReady && !userInitiated) {
      this._consecutiveReconnectFailures++;
    }
    this._awaitingReconnectReady = false;

    if (shouldRetry) {
      this.setConnectionState(ConnectionState.Reconnecting);
      this.startReconnectLoop();
      return;
    }

    if (wasConnected) {
      this.emitConnectionClosed(code, reason, disconnectReason);
    }

    this.handleTerminalDisconnect(
      new ConnectionError(
        reason || "Connection closed",
        this.hasNoRetryCloseCode()
          ? (this._lastCloseErrorCode ?? OjinErrorCode.ConnectionFailed)
          : OjinErrorCode.NotConnected,
        { closeCode: code, closeReason: reason },
      ),
    );
  }

  private wsSend(data: string | Uint8Array): void {
    this.transport?.send(data);
  }

  private handleTerminalDisconnect(error: ConnectionError | AuthError): void {
    this.rejectPendingThrottleQueue(
      error instanceof ConnectionError
        ? error
        : new ConnectionError(error.message, error.code, error.details),
    );
    this.resetRateLimitRetryState();
    this.abortController.abort();
    this._awaitingReconnectReady = false;
    this.setConnectionState(ConnectionState.Disconnected);
  }

  private getPerfNow(): number {
    return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : 0;
  }

  /**
   * Abortable sleep primitive. Resolves after `ms` milliseconds, or rejects
   * with `OjinError(NotConnected)` as soon as the per-instance abort
   * controller fires (i.e., `close()` is called). Every internal backoff wait
   * in the reconnect loop MUST use this helper — raw `setTimeout` calls bypass
   * the abort channel and would leave ghost timers alive after `close()`.
   */
  private sleep(ms: number): Promise<void> {
    return abortableSleep(
      ms,
      this.abortController.signal,
      () => new OjinError("Operation aborted", OjinErrorCode.NotConnected),
    );
  }

  private chunkAndSendAudio(message: OjinAudioInputMessage): void {
    const audioBytes = message.audioInt16Bytes;

    if (audioBytes.length === 0) {
      this.wsSend(new OjinAudioInputMessage(new Uint8Array(0), message.params).toBytes());
      return;
    }

    for (let i = 0; i < audioBytes.length; i += this.audioChunkSize) {
      const end = Math.min(i + this.audioChunkSize, audioBytes.length);
      const chunk = audioBytes.subarray(i, end);
      const chunkMsg = new OjinAudioInputMessage(new Uint8Array(chunk), message.params);
      this.wsSend(chunkMsg.toBytes());
    }
  }
}
