/**
 * Node WebSocket transport with client-initiated heartbeat pings.
 *
 * This module is Node-only. The `ws` package exposes `WebSocket.ping()` which
 * is not available in the browser WebSocket API.
 *
 * Lifecycle rules:
 *  - Heartbeat starts after the WebSocket `open` event.
 *  - The interval handle is `.unref()`'d immediately — it never holds the
 *    Node event loop open past `close()` (AC#3).
 *  - On `close()`, the interval is cleared BEFORE the underlying socket is
 *    closed (AC#4).
 *  - On every `connect()` call the interval is cleared first (AC#5), then
 *    restarted after a successful `open`.
 *  - Ping errors are logged at `"debug"` level and discarded; they do NOT
 *    drive connection state. The inbound-idle check is the authority (AC#6).
 */

import WebSocket from "ws";
import {
  classifyUpgradeFailureByClose,
  classifyUpgradeFailureByStatus,
} from "./protocol/error-mapping.js";
import type { OjinLogger } from "./utils/logger.js";

/**
 * Low-level WebSocket transport interface used internally by {@link OjinClient}.
 *
 * Exposed so that consumers can provide a custom implementation (e.g. a test
 * double) when constructing an {@link OjinClient}.
 */
export interface WSTransport {
  connect(url: string, headers: Record<string, string>): Promise<void>;
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: Uint8Array, isBinary: boolean) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
  readonly isOpen: boolean;
  setNoDelay(): void;
}

/** Default interval between client-originated ping frames (milliseconds). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Options for the heartbeat-enabled Node WebSocket transport.
 */
export interface NodeWSTransportOptions {
  /**
   * Milliseconds between client-originated ping frames.
   *
   * Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS} (30 000 ms).
   *
   * The resulting interval handle is `.unref()`'d so it does not prevent the
   * Node process from exiting once `close()` is called.
   */
  heartbeatIntervalMs?: number;
  /**
   * Optional logger. Ping errors are emitted at `"debug"` level and
   * discarded; they do not influence connection state.
   */
  logger?: OjinLogger;
}

/**
 * Node-only WebSocket transport with client-originated heartbeat pings.
 *
 * Sends a ping frame every `heartbeatIntervalMs` milliseconds as a
 * belt-and-braces liveness hedge alongside the authoritative inbound-idle
 * check (ost-n3u7). The interval is `.unref()`'d immediately so it never
 * holds the Node event loop open past `close()`.
 */
export class NodeWSTransport implements WSTransport {
  private ws: WebSocket | null = null;
  private messageHandler: ((data: Uint8Array, isBinary: boolean) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  /** Active heartbeat interval handle, or `null` when not running. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly heartbeatIntervalMs: number;
  private readonly logger: OjinLogger | null;

  constructor(options?: NodeWSTransportOptions) {
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.logger = options?.logger ?? null;
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the given URL with the provided headers.
   *
   * Any previous heartbeat interval is cleared at the start of this call
   * (AC#5 — safe to call on reconnect). A new interval is started after
   * the WebSocket `open` event fires.
   */
  async connect(url: string, headers: Record<string, string>): Promise<void> {
    // AC#5: clear any prior heartbeat at the start of every connect attempt.
    this.clearHeartbeat();

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      let opened = false;

      ws.on("open", () => {
        opened = true;
        // AC#2+3: start the heartbeat after a successful open.
        this.startHeartbeat();
        resolve();
      });

      // Fired by the `ws` library when the server responds to the HTTP upgrade
      // request with a non-101 status (e.g. 401 Unauthorized, 503 Service
      // Unavailable). The socket is NOT automatically destroyed; we must clean
      // it up and reject the connect promise with a typed error.
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        reject(classifyUpgradeFailureByStatus(status));
      });

      ws.on("error", (err: Error) => {
        reject(err);
        this.errorHandler?.(err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString("utf-8");
        if (!opened) {
          // Close fired before the WebSocket handshake completed. Classify the
          // close code/reason as a typed error and reject the connect promise.
          // Do NOT invoke closeHandler — the connection was never established.
          reject(classifyUpgradeFailureByClose(code, reasonStr));
          return;
        }
        this.closeHandler?.(code, reasonStr);
      });

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (this.messageHandler) {
          const bytes =
            data instanceof Buffer
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : new Uint8Array(data as ArrayBuffer);
          this.messageHandler(bytes, isBinary);
        }
      });

      // Assign to this.ws before any async events so that a concurrent
      // close() call can send a proper close frame during the handshake phase.
      this.ws = ws;
    });
  }

  send(data: string | Uint8Array): void {
    if (!this.ws) throw new Error("WebSocket not connected");
    this.ws.send(data);
  }

  /**
   * Close the transport.
   *
   * The heartbeat interval is cleared **before** the underlying WebSocket is
   * closed (AC#4) so the interval cannot fire against a half-torn-down socket.
   */
  close(): void {
    // AC#4: clear interval BEFORE closing the socket.
    this.clearHeartbeat();
    this.ws?.close();
  }

  onMessage(handler: (data: Uint8Array, isBinary: boolean) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  setNoDelay(): void {
    if (!this.ws) return;
    try {
      const socket = (this.ws as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })
        ._socket;
      socket?.setNoDelay?.(true);
    } catch {
      // Ignore TCP_NODELAY failures — not critical.
    }
  }

  /**
   * Start the periodic ping interval.
   *
   * Called from the `open` event handler. The interval is `.unref()`'d
   * immediately (AC#3) so it does not hold the Node event loop open past
   * `close()`. Ping errors are logged at `"debug"` level and discarded
   * (AC#6) — they do not influence connection state.
   */
  private startHeartbeat(): void {
    const ws = this.ws;
    if (!ws) return;

    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // AC#6: discard ping errors — pong absence is NOT load-bearing.
      ws.ping(undefined, undefined, (err) => {
        if (err && this.logger?.isLevelEnabled("debug")) {
          this.logger.debug("Heartbeat ping error (ignored)", { error: err.message });
        }
      });
    }, this.heartbeatIntervalMs);

    // AC#3: .unref() so this interval never prevents the Node process from exiting.
    timer.unref();
    this.heartbeatTimer = timer;
  }

  /**
   * Clear the active heartbeat interval if one is running.
   *
   * Safe to call when no interval is set (no-op).
   */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * Create a heartbeat-enabled Node WebSocket transport.
 *
 * @param options - Optional heartbeat interval (default: `30_000` ms) and logger.
 * @returns A {@link WSTransport} that sends periodic ping frames on Node.js.
 */
export function createNodeWSTransport(options?: NodeWSTransportOptions): WSTransport {
  return new NodeWSTransport(options);
}
