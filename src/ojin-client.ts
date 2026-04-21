import { ConnectionError, ProtocolError } from "./errors.js";
import { OjinEvent, OjinEventEmitter } from "./events.js";
import {
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinEndInteractionMessage,
  OjinErrorResponseMessage,
  OjinInteractionResponseMessage,
  type OjinMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
} from "./protocol/client-messages.js";
import {
  deserializeInteractionResponseMessage,
  type ErrorResponseMessage,
} from "./protocol/interaction-messages.js";
import { MessageType } from "./protocol/session-messages.js";
import { ConnectionState, type OjinClientOptions } from "./types.js";
import { createWSTransport, type WSTransport } from "./ws-transport.js";

/** Maximum chunk size for audio data in bytes (500KB). */
const MAX_AUDIO_CHUNK_SIZE = 1024 * 500;

/**
 * OjinClient — WebSocket client for communicating with the OJIN STV service.
 */
export class OjinClient {
  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly configId: string;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly mode: string | null;

  private transport: WSTransport | null = null;
  private _connectionState: ConnectionState = ConnectionState.Disconnected;
  private _inferenceServerReady = false;
  private _cancelled = false;

  /** Typed event emitter for client events. */
  readonly events = new OjinEventEmitter();

  private responseQueue: OjinMessage[] = [];
  private responseResolvers: Array<(msg: OjinMessage | null) => void> = [];

  constructor(options: OjinClientOptions) {
    this.wsUrl = options.wsUrl;
    this.apiKey = options.apiKey;
    this.configId = options.configId;
    this.reconnectAttempts = options.reconnectAttempts ?? 3;
    this.reconnectDelay = options.reconnectDelay ?? 1.0;
    this.mode = options.mode ?? null;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get isServerReady(): boolean {
    return this._inferenceServerReady;
  }

  async connect(): Promise<void> {
    if (
      this._connectionState === ConnectionState.Connected ||
      this._connectionState === ConnectionState.Connecting
    ) {
      return;
    }

    this.setConnectionState(ConnectionState.Connecting);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.reconnectAttempts; attempt++) {
      try {
        const url = `${this.wsUrl}?config_id=${this.configId}${this.mode === "dev" ? `&mode=${this.mode}` : ""}`;
        const headers: Record<string, string> = { Authorization: this.apiKey };

        this.transport = createWSTransport();

        this.transport.onMessage((data, isBinary) => {
          this.handleMessage(data, isBinary);
        });

        this.transport.onClose((code, reason) => {
          this.handleClose(code, reason);
        });

        this.transport.onError((err) => {
          console.error("WebSocket error:", err);
        });

        await this.transport.connect(url, headers);
        this.transport.setNoDelay();

        this.setConnectionState(ConnectionState.Connected);
        this.events.emit(OjinEvent.ConnectionOpened);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.reconnectAttempts - 1) {
          await new Promise((r) => setTimeout(r, this.reconnectDelay * 1000));
        }
      }
    }

    this.setConnectionState(ConnectionState.Disconnected);
    throw new ConnectionError(
      `Failed to connect after ${this.reconnectAttempts} attempts: ${lastError?.message}`,
    );
  }

  async close(): Promise<void> {
    if (this._connectionState === ConnectionState.Disconnected) {
      return;
    }

    this.setConnectionState(ConnectionState.Disconnecting);
    this.drainResponseMessages();

    this.transport?.close();
    this.transport = null;

    for (const resolver of this.responseResolvers) {
      resolver(null);
    }
    this.responseResolvers = [];
    this.responseQueue = [];
    this.setConnectionState(ConnectionState.Disconnected);
  }

  async startInteraction(): Promise<void> {
    this.drainResponseMessages();
  }

  async sendMessage(message: OjinMessage): Promise<void> {
    this.ensureConnected();

    if (message instanceof OjinCancelInteractionMessage) {
      this._cancelled = true;
      const cancelPayload = message.toProxyMessage() as Record<string, unknown>;
      const cancelMsg = {
        type: MessageType.CancelInteraction,
        payload: cancelPayload,
      };
      this.wsSend(JSON.stringify(cancelMsg));
      this.drainResponseMessages();
      this._cancelled = false;
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
      const proxyMsg = message.toProxyMessage();
      this.wsSend(JSON.stringify(proxyMsg));
      return;
    }

    throw new ProtocolError(`Unknown message type: ${message.constructor.name}`);
  }

  async receiveMessage(): Promise<OjinMessage | null> {
    if (this._cancelled) {
      return null;
    }

    const queued = this.responseQueue.shift();
    if (queued !== undefined) {
      return queued;
    }

    return new Promise<OjinMessage | null>((resolve) => {
      this.responseResolvers.push(resolve);
    });
  }

  isConnected(): boolean {
    return this.transport?.isOpen ?? false;
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.events.emit(OjinEvent.ConnectionStateChanged, state);
  }

  private ensureConnected(): void {
    if (!this.transport?.isOpen || this._connectionState !== ConnectionState.Connected) {
      throw new ConnectionError("Not connected to OJIN STV service");
    }
    if (!this._inferenceServerReady) {
      throw new ConnectionError("Inference Server is not ready to receive messages");
    }
  }

  private handleMessage(data: Uint8Array, isBinary: boolean): void {
    try {
      if (isBinary) {
        try {
          const responseMsg = deserializeInteractionResponseMessage(data);
          const ojinResponse = OjinInteractionResponseMessage.fromProxyMessage(responseMsg);
          this.enqueueResponse(ojinResponse);
          this.events.emit(OjinEvent.InteractionResponse, ojinResponse);
        } catch (err) {
          console.error("Error parsing binary response:", err);
        }
        return;
      }

      const text = new TextDecoder().decode(data);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.error("Error parsing JSON message:", text);
        return;
      }

      const msgType = parsed.type as string;

      if (msgType === MessageType.SessionReady) {
        const payload = (parsed.payload ?? {}) as Record<string, unknown>;
        const sessionReady = new OjinSessionReadyMessage(
          (payload.parameters as Record<string, unknown>) ?? null,
        );
        this._inferenceServerReady = true;
        this.enqueueResponse(sessionReady);
        this.events.emit(OjinEvent.SessionReady, sessionReady);
        return;
      }

      if (msgType === MessageType.SessionPing) {
        return;
      }

      if (msgType === MessageType.ErrorResponse) {
        const errorMsg = parsed as unknown as ErrorResponseMessage;
        const ojinError = new OjinErrorResponseMessage(errorMsg.payload);
        this.enqueueResponse(ojinError);
        this.events.emit(OjinEvent.Error, ojinError);
        return;
      }

      if (msgType === MessageType.InteractionResponse) {
        console.warn("Received text-based interaction response, expected binary");
        return;
      }

      console.warn(`Unknown message type: ${msgType}`);
    } catch (err) {
      console.error("Error handling message:", err);
    }
  }

  private handleClose(code: number, reason: string): void {
    const wasConnected = this._connectionState === ConnectionState.Connected;
    this.transport = null;
    this.setConnectionState(ConnectionState.Disconnected);

    if (wasConnected) {
      this.events.emit(OjinEvent.ConnectionClosed, code, reason);
    }

    for (const resolver of this.responseResolvers) {
      resolver(null);
    }
    this.responseResolvers = [];
  }

  private enqueueResponse(msg: OjinMessage): void {
    const resolver = this.responseResolvers.shift();
    if (resolver !== undefined) {
      resolver(msg);
    } else {
      this.responseQueue.push(msg);
    }
  }

  private drainResponseMessages(): void {
    this.responseQueue = [];
  }

  private wsSend(data: string | Uint8Array): void {
    this.transport?.send(data);
  }

  private chunkAndSendAudio(message: OjinAudioInputMessage): void {
    const audioBytes = message.audioInt16Bytes;

    if (audioBytes.length === 0) {
      this.wsSend(new OjinAudioInputMessage(new Uint8Array(0), message.params).toBytes());
      return;
    }

    for (let i = 0; i < audioBytes.length; i += MAX_AUDIO_CHUNK_SIZE) {
      const end = Math.min(i + MAX_AUDIO_CHUNK_SIZE, audioBytes.length);
      const chunk = audioBytes.subarray(i, end);
      const chunkMsg = new OjinAudioInputMessage(new Uint8Array(chunk), message.params);
      this.wsSend(chunkMsg.toBytes());
    }
  }
}
