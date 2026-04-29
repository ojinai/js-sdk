import type { OjinError } from "./errors.js";
import type {
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
} from "./protocol/client-messages.js";
import type { ConnectionState, DisconnectReason } from "./types.js";
import { type OjinLogger, silent } from "./utils/logger.js";

/** Enum of all events emitted by OjinClient. */
export enum OjinEvent {
  /** Fired when the connection state changes. */
  ConnectionStateChanged = "session.state_changed",
  /** Fired when the WebSocket connection is established. */
  ConnectionOpened = "connection.opened",
  /** Fired when the session is closed permanently. */
  ConnectionClosed = "session.closed",
  /** Fired when the session is ready (inference server is ready). */
  SessionReady = "session.ready",
  /** Fired when an interaction response is received. */
  InteractionResponse = "interaction.response",
  /** Fired when an error is received from the server. */
  Error = "interaction.error",
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
  [OjinEvent.ConnectionClosed]: (payload: {
    code: number;
    reason: string;
    disconnectReason: DisconnectReason;
  }) => void;
  [OjinEvent.SessionReady]: (message: OjinSessionReadyMessage) => void;
  [OjinEvent.InteractionResponse]: (message: OjinInteractionResponseMessage) => void;
  [OjinEvent.Error]: (error: OjinError) => void;
  [OjinEvent.WaitingForReady]: (payload: { configId: string; elapsedMs: number }) => void;
  [OjinEvent.QueueOverflow]: (payload: { dropped: number }) => void;
  [OjinEvent.Reconnecting]: (payload: { attempt: number; delayMs: number }) => void;
  [OjinEvent.Reconnected]: () => void;
}

type EventListener = {
  callback: (...args: unknown[]) => void;
  original: (...args: unknown[]) => void;
};

/** Type-safe event emitter for OjinClient events. */
export class OjinEventEmitter {
  private listeners: { [K in OjinEvent]?: Set<EventListener> } = {};
  private readonly logger: OjinLogger;

  constructor(logger: OjinLogger = silent) {
    this.logger = logger;
  }

  /**
   * Registers a listener and returns an idempotent unsubscribe function.
   */
  on<K extends OjinEvent>(event: K, callback: OjinEventCallbacks[K]): () => void {
    return this.addListener(event, callback);
  }

  /**
   * Registers a listener that is removed before its first invocation.
   */
  once<K extends OjinEvent>(event: K, callback: OjinEventCallbacks[K]): () => void {
    return this.addListener(event, callback, { once: true });
  }

  /**
   * Removes all listeners registered with the provided callback.
   */
  off<K extends OjinEvent>(event: K, callback: OjinEventCallbacks[K]): void {
    const listeners = this.listeners[event];
    if (!listeners) {
      return;
    }

    const original = callback as (...args: unknown[]) => void;
    for (const listener of listeners) {
      if (listener.original === original || listener.callback === original) {
        listeners.delete(listener);
      }
    }

    if (listeners.size === 0) {
      delete this.listeners[event];
    }
  }

  /**
   * Emits a typed event payload to all subscribed listeners.
   */
  emit<K extends OjinEvent>(
    event: K,
    ...args: OjinEventCallbacks[K] extends (...args: infer P) => void ? P : never
  ): void {
    for (const listener of this.listeners[event] ?? []) {
      try {
        listener.callback(...args);
      } catch (err) {
        this.logger.error(`Error in ${event} event handler`, {
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Removes all listeners for a specific event or for the entire emitter.
   */
  removeAllListeners(event?: OjinEvent): void {
    if (event) {
      delete this.listeners[event];
    } else {
      for (const key of Object.keys(this.listeners) as OjinEvent[]) {
        delete this.listeners[key];
      }
    }
  }

  private addListener<K extends OjinEvent>(
    event: K,
    callback: OjinEventCallbacks[K],
    options?: { once?: boolean },
  ): () => void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }

    const original = callback as (...args: unknown[]) => void;
    let unsubscribed = false;
    let listener: EventListener;
    const unsubscribe = () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;
      this.listeners[event]?.delete(listener);
      if (this.listeners[event]?.size === 0) {
        delete this.listeners[event];
      }
    };

    listener = {
      callback: options?.once
        ? (...args: unknown[]) => {
            unsubscribe();
            original(...args);
          }
        : original,
      original,
    };

    this.listeners[event]?.add(listener);
    return unsubscribe;
  }
}
