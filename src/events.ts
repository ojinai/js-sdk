import type { OjinError } from "./errors.js";
import type {
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
} from "./protocol/client-messages.js";
import type { ConnectionState } from "./types.js";
import { type OjinLogger, silent } from "./utils/logger.js";

/** Enum of all events emitted by OjinClient. */
export enum OjinEvent {
  /** Fired when the connection state changes. */
  ConnectionStateChanged = "connectionStateChanged",
  /** Fired when the WebSocket connection is established. */
  ConnectionOpened = "connectionOpened",
  /** Fired when the WebSocket connection is closed. */
  ConnectionClosed = "connectionClosed",
  /** Fired when the session is ready (inference server is ready). */
  SessionReady = "sessionReady",
  /** Fired when an interaction response is received. */
  InteractionResponse = "interactionResponse",
  /** Fired when an error is received from the server. */
  Error = "error",
  /**
   * Fired exactly once when the first concurrent caller enters
   * `waitForReady()` while the inference server is not yet ready.
   * Gives UIs a one-shot signal to render a loading indicator.
   * Payload: `{ configId: string, elapsedMs: number }`.
   */
  WaitingForReady = "session.waiting_for_ready",
  /**
   * Fired when the outgoing pre-ready buffer overflows under `dropOldest` or
   * `dropNewest` policy. Rate-limited to at most one emission per 5-second
   * window. Payload: `{ dropped: N }` — total messages dropped since the
   * last emission.
   */
  QueueOverflow = "queue.overflow",
  /** Fired before an automatic reconnect attempt begins. */
  Reconnecting = "connection.reconnecting",
  /** Fired after the transport reconnects and before fresh session readiness. */
  Reconnected = "connection.reconnected",
}

/** Typed event callback signatures for OjinClient events. */
export interface OjinEventCallbacks {
  [OjinEvent.ConnectionStateChanged]: (state: ConnectionState) => void;
  [OjinEvent.ConnectionOpened]: () => void;
  [OjinEvent.ConnectionClosed]: (code: number, reason: string) => void;
  [OjinEvent.SessionReady]: (message: OjinSessionReadyMessage) => void;
  [OjinEvent.InteractionResponse]: (message: OjinInteractionResponseMessage) => void;
  [OjinEvent.Error]: (error: OjinError) => void;
  [OjinEvent.WaitingForReady]: (payload: { configId: string; elapsedMs: number }) => void;
  [OjinEvent.QueueOverflow]: (payload: { dropped: number }) => void;
  [OjinEvent.Reconnecting]: (payload: { attempt: number; delayMs: number }) => void;
  [OjinEvent.Reconnected]: () => void;
}

/** Type-safe event emitter for OjinClient events. */
export class OjinEventEmitter {
  private listeners: { [K in OjinEvent]?: Set<(...args: unknown[]) => void> } = {};
  private readonly logger: OjinLogger;

  constructor(logger: OjinLogger = silent) {
    this.logger = logger;
  }

  on<K extends OjinEvent>(event: K, callback: OjinEventCallbacks[K]): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event]?.add(callback as (...args: unknown[]) => void);
  }

  off<K extends OjinEvent>(event: K, callback: OjinEventCallbacks[K]): void {
    this.listeners[event]?.delete(callback as (...args: unknown[]) => void);
  }

  emit<K extends OjinEvent>(
    event: K,
    ...args: OjinEventCallbacks[K] extends (...args: infer P) => void ? P : never
  ): void {
    this.listeners[event]?.forEach((callback) => {
      try {
        (callback as (...args: unknown[]) => void)(...args);
      } catch (err) {
        this.logger.error(`Error in ${event} event handler`, {
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  removeAllListeners(event?: OjinEvent): void {
    if (event) {
      delete this.listeners[event];
    } else {
      for (const key of Object.keys(this.listeners) as OjinEvent[]) {
        delete this.listeners[key];
      }
    }
  }
}
