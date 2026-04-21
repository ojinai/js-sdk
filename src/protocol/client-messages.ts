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

// ─── Base message ─────────────────────────────────────────────────────────────

/** Base class for all Ojin STV messages. */
export abstract class OjinMessage {
  /** Convert the message to a proxy message format. */
  abstract toProxyMessage(): unknown;
}

// ─── Session ready ────────────────────────────────────────────────────────────

/** Message indicating that a session is ready. */
export class OjinSessionReadyMessage extends OjinMessage {
  constructor(public readonly parameters: Record<string, unknown> | null) {
    super();
  }

  toProxyMessage(): unknown {
    throw new Error("Method not implemented.");
  }
}

/** Ping message used to check session readiness. */
export class OjinSessionReadyPing extends OjinMessage {
  toProxyMessage(): unknown {
    throw new Error("Method not implemented.");
  }
}

// ─── Interaction response ─────────────────────────────────────────────────────

/** Response message containing video/audio data from the persona. */
export class OjinInteractionResponseMessage extends OjinMessage {
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

  toProxyMessage(): unknown {
    throw new Error("Method not implemented.");
  }
}

// ─── Cancel interaction ───────────────────────────────────────────────────────

/** Message to cancel an interaction. */
export class OjinCancelInteractionMessage extends OjinMessage {
  toProxyMessage(): CancelInteractionInput {
    return {
      timestamp: Date.now(),
    };
  }

  /** Create the full cancel message wrapper. */
  toCancelInteractionMessage(): CancelInteractionMessage {
    return {
      type: MessageType.CancelInteraction,
      payload: this.toProxyMessage() as CancelInteractionInput,
    };
  }
}

// ─── End interaction ──────────────────────────────────────────────────────────

/** Message to end an interaction. */
export class OjinEndInteractionMessage extends OjinMessage {
  toProxyMessage(): EndInteractionMessage {
    return {
      type: MessageType.EndInteraction,
      payload: {
        timestamp: Date.now(),
      },
    };
  }
}

// ─── Text input ───────────────────────────────────────────────────────────────

/** Message containing text input for the persona. */
export class OjinTextInputMessage extends OjinMessage {
  constructor(
    public readonly text: string,
    public readonly params?: Record<string, unknown> | null,
  ) {
    super();
  }

  toProxyMessage(): InteractionInputMessage {
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
    return serializeInteractionInputMessage(this.toProxyMessage());
  }
}

// ─── Audio input ─────────────────────────────────────────────────────────────

/** Message containing audio input for the persona. */
export class OjinAudioInputMessage extends OjinMessage {
  constructor(
    public readonly audioInt16Bytes: Uint8Array<ArrayBuffer>,
    public readonly params?: Record<string, unknown> | null,
  ) {
    super();
  }

  toProxyMessage(): InteractionInputMessage {
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
    return serializeInteractionInputMessage(this.toProxyMessage());
  }
}

// ─── Error response ───────────────────────────────────────────────────────────

/** Error response message received from the server. */
export class OjinErrorResponseMessage extends OjinMessage {
  constructor(public readonly error: ErrorResponse) {
    super();
  }

  toProxyMessage(): unknown {
    return this.error;
  }
}
