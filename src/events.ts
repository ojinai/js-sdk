import type {
  OjinErrorResponseMessage,
  OjinInteractionResponseMessage,
  OjinSessionReadyMessage,
} from "./protocol/client-messages.js";
import type { ConnectionState } from "./types.js";

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
}

/** Typed event callback signatures for OjinClient events. */
export interface OjinEventCallbacks {
  [OjinEvent.ConnectionStateChanged]: (state: ConnectionState) => void;
  [OjinEvent.ConnectionOpened]: () => void;
  [OjinEvent.ConnectionClosed]: (code: number, reason: string) => void;
  [OjinEvent.SessionReady]: (message: OjinSessionReadyMessage) => void;
  [OjinEvent.InteractionResponse]: (message: OjinInteractionResponseMessage) => void;
  [OjinEvent.Error]: (message: OjinErrorResponseMessage) => void;
}

/** Type-safe event emitter for OjinClient events. */
export class OjinEventEmitter {
  private listeners: { [K in OjinEvent]?: Set<(...args: unknown[]) => void> } = {};

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
        console.error(`Error in ${event} event handler:`, err);
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
