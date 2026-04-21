import { NIL_UUID } from "../utils/uuid.js";
import {
  type CancelInteractionInput,
  type CancelInteractionMessage,
  type EndInteractionMessage,
  type ErrorResponse,
  type InteractionInputMessage,
  type InteractionResponseMessage,
  serializeInteractionInputMessage,
} from "./interaction-messages.js";
import { MessageType } from "./session-messages.js";

// ─── Frame type ───────────────────────────────────────────────────────────────

/** Frame type for image payloads. */
export enum FrameType {
  /** Idle frames from source video */
  Idle = 0,
  /** Speech-generated frames */
  Speech = 1,
}

// ─── Base messages ────────────────────────────────────────────────────────────

/** Base class for all Ojin STV messages. */
export abstract class OjinMessage {}

/**
 * Base class for client-bound (outgoing) Ojin messages.
 *
 * Carries the two serialization methods required to send a message over the
 * wire: `toMessage()` for the logical shape (useful for debug logging) and
 * `toBytes()` for the actual wire encoding.
 *
 * The `declare` brand is a compile-time-only nominal tag that prevents
 * `OjinClientMessage` from being structurally assignable to `OjinServerMessage`
 * (and vice-versa), which would otherwise be possible because TypeScript uses
 * structural subtyping for classes.
 */
export abstract class OjinClientMessage extends OjinMessage {
  private declare readonly _ojinMessageKind: "client";

  /** Convert the message to its logical shape (for debug logging). */
  abstract toMessage(): unknown;
  /** Serialize the message to its wire form. */
  abstract toBytes(): string | Uint8Array;
}

/**
 * Marker base class for server-bound (incoming) Ojin messages.
 *
 * Server messages are received from the proxy; they cannot be serialized and
 * sent by the client.  Keeping them on a separate branch of the hierarchy lets
 * the compiler reject any attempt to pass a server message to
 * `OjinClient.sendMessage`.
 *
 * The `declare` brand (see `OjinClientMessage`) makes this class nominally
 * distinct from `OjinClientMessage` at the type level.
 */
export abstract class OjinServerMessage extends OjinMessage {
  private declare readonly _ojinMessageKind: "server";
}

// ─── Session ready ────────────────────────────────────────────────────────────

/** Message indicating that a session is ready. */
export class OjinSessionReadyMessage extends OjinServerMessage {
  constructor(public readonly parameters: Record<string, unknown> | null) {
    super();
  }
}

/** Ping message used to check session readiness. */
export class OjinSessionReadyPing extends OjinServerMessage {}

// ─── Interaction response ─────────────────────────────────────────────────────

/** Response message containing video/audio data from the persona. */
export class OjinInteractionResponseMessage extends OjinServerMessage {
  constructor(
    public readonly interactionId: string,
    public readonly videoFrameBytes: Uint8Array<ArrayBuffer>,
    public readonly audioFrameBytes: Uint8Array<ArrayBuffer>,
    public readonly isFinalResponse: boolean = false,
    public readonly index: number,
    public readonly frameType: FrameType = FrameType.Speech,
  ) {
    super();
  }

  /** Create from a deserialized proxy message. */
  static fromProxyMessage(
    proxyMessage: InteractionResponseMessage,
  ): OjinInteractionResponseMessage {
    let videoFrameBytes = new Uint8Array(0);
    let audioFrameBytes = new Uint8Array(0);

    for (const entry of proxyMessage.payload.payloads) {
      if (entry.payloadType === "image") {
        videoFrameBytes = entry.data as Uint8Array<ArrayBuffer>;
      } else if (entry.payloadType === "audio") {
        audioFrameBytes = entry.data as Uint8Array<ArrayBuffer>;
      }
    }

    const interactionId = proxyMessage.payload.interactionId;
    const frameType = interactionId === NIL_UUID ? FrameType.Idle : FrameType.Speech;

    return new OjinInteractionResponseMessage(
      interactionId,
      videoFrameBytes,
      audioFrameBytes,
      proxyMessage.payload.isFinalResponse,
      proxyMessage.payload.index,
      frameType,
    );
  }
}

// ─── Cancel interaction ───────────────────────────────────────────────────────

/** Message to cancel an interaction. */
export class OjinCancelInteractionMessage extends OjinClientMessage {
  toMessage(): CancelInteractionInput {
    return {
      timestamp: Date.now(),
    };
  }

  /** Serialize to JSON wire format. */
  toBytes(): string {
    return JSON.stringify({
      type: MessageType.CancelInteraction,
      payload: this.toMessage(),
    });
  }

  /** Create the full cancel message wrapper. */
  toCancelInteractionMessage(): CancelInteractionMessage {
    return {
      type: MessageType.CancelInteraction,
      payload: this.toMessage(),
    };
  }
}

// ─── End interaction ──────────────────────────────────────────────────────────

/** Message to end an interaction. */
export class OjinEndInteractionMessage extends OjinClientMessage {
  toMessage(): EndInteractionMessage {
    return {
      type: MessageType.EndInteraction,
      payload: {
        timestamp: Date.now(),
      },
    };
  }

  /** Serialize to JSON wire format. */
  toBytes(): string {
    return JSON.stringify(this.toMessage());
  }
}

// ─── Text input ───────────────────────────────────────────────────────────────

/** Message containing text input for the persona. */
export class OjinTextInputMessage extends OjinClientMessage {
  constructor(
    public readonly text: string,
    public readonly params?: Record<string, unknown> | null,
  ) {
    super();
  }

  toMessage(): InteractionInputMessage {
    return {
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "text",
        payload: new TextEncoder().encode(this.text),
        timestamp: Date.now(),
        params: this.params ?? null,
      },
    };
  }

  /** Serialize to binary format. */
  toBytes(): Uint8Array {
    return serializeInteractionInputMessage(this.toMessage());
  }
}

// ─── Audio input ─────────────────────────────────────────────────────────────

/** Message containing audio input for the persona. */
export class OjinAudioInputMessage extends OjinClientMessage {
  constructor(
    public readonly audioInt16Bytes: Uint8Array<ArrayBuffer>,
    public readonly params?: Record<string, unknown> | null,
  ) {
    super();
  }

  toMessage(): InteractionInputMessage {
    return {
      type: MessageType.InteractionInput,
      payload: {
        payloadType: "audio",
        payload: this.audioInt16Bytes,
        timestamp: Date.now(),
        params: this.params ?? null,
      },
    };
  }

  /** Serialize to binary format. */
  toBytes(): Uint8Array {
    return serializeInteractionInputMessage(this.toMessage());
  }
}

// ─── Error response ───────────────────────────────────────────────────────────

/** Error response message received from the server. */
export class OjinErrorResponseMessage extends OjinServerMessage {
  constructor(public readonly error: ErrorResponse) {
    super();
  }
}
