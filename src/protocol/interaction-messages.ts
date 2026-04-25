import { bytesToUuid, uuidToBytes } from "../utils/uuid.js";
import { MessageType } from "./session-messages.js";

// ─── Binary protocol constants ───────────────────────────────────────────────

// Interaction input format: Byte payload type, uint64 timestamp, uint32 params size
const INTERACTION_INPUT_HEADER_SIZE = 1 + 8 + 4; // 13 bytes

// Interaction response format: Byte is_final, 16b UUID, uint64 timestamp,
// uint32 usage, uint32 index, uint32 num payload entries
const INTERACTION_RESPONSE_HEADER_SIZE = 1 + 16 + 8 + 4 + 4 + 4; // 37 bytes

// Payload entry format: uint32 data size + Byte payload type
const PAYLOAD_ENTRY_HEADER_SIZE = 4 + 1; // 5 bytes

// ─── DataView helpers for isomorphic binary I/O ───────────────────────────────

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  );
}

// ─── Payload type enum ───────────────────────────────────────────────────────

/** Payload type constants for binary serialization. */
export enum PayloadType {
  Text = 0,
  Audio = 1,
  Image = 2,
  Video = 3,
}

/** Convert a string payload type name to its PayloadType enum value. */
export function payloadTypeFromStr(str: string): PayloadType {
  const map: Record<string, PayloadType> = {
    text: PayloadType.Text,
    audio: PayloadType.Audio,
    image: PayloadType.Image,
    video: PayloadType.Video,
  };
  return map[str.toLowerCase()] ?? PayloadType.Text;
}

/** Convert a PayloadType enum value to its string name. */
export function payloadTypeToStr(pt: PayloadType): string {
  const map: Record<number, string> = {
    [PayloadType.Text]: "text",
    [PayloadType.Audio]: "audio",
    [PayloadType.Image]: "image",
    [PayloadType.Video]: "video",
  };
  return map[pt] ?? "text";
}

// ─── Data interfaces ─────────────────────────────────────────────────────────

/** Interaction input data. */
export interface InteractionInput {
  payloadType: string;
  payload: Uint8Array;
  timestamp: number;
  params?: Record<string, unknown> | null;
}

/** End interaction data. */
export interface EndInteraction {
  timestamp: number;
}

/** End interaction message. */
export interface EndInteractionMessage {
  type: MessageType.EndInteraction;
  payload: EndInteraction;
}

/** Input payload for cancelling an interaction. */
export interface CancelInteractionInput {
  timestamp?: number | null;
}

/** Interaction cancel message. */
export interface CancelInteractionMessage {
  type: MessageType.CancelInteraction;
  payload: CancelInteractionInput;
}

/** Single payload entry within an interaction response. */
export interface InteractionResponsePayload {
  payloadType: string;
  data: Uint8Array;
}

/** Interaction response data. */
export interface InteractionResponse {
  interactionId: string;
  payloads: InteractionResponsePayload[];
  isFinalResponse: boolean;
  timestamp: number;
  usage: number;
  index: number;
}

/** Error response data. */
export interface ErrorResponse {
  interactionId?: string | null;
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  timestamp: number;
}

/** Interaction input message (binary-serialized). */
export interface InteractionInputMessage {
  type: MessageType.InteractionInput;
  payload: InteractionInput;
}

/** Interaction response message (binary-serialized). */
export interface InteractionResponseMessage {
  type: MessageType.InteractionResponse;
  payload: InteractionResponse;
}

/** Error response message sent from proxy to client. */
export interface ErrorResponseMessage {
  type: MessageType.ErrorResponse;
  payload: ErrorResponse;
}

// ─── Binary serialization ────────────────────────────────────────────────────

/** Serialize an InteractionInputMessage to bytes (isomorphic). */
export function serializeInteractionInputMessage(msg: InteractionInputMessage): Uint8Array {
  const payloadType = payloadTypeFromStr(msg.payload.payloadType);
  const timestamp = msg.payload.timestamp;

  const paramsStr = msg.payload.params ? JSON.stringify(msg.payload.params) : "";
  const encoder = new TextEncoder();
  const paramsBytes = encoder.encode(paramsStr);
  const paramsSize = paramsBytes.length;

  const headerSize = INTERACTION_INPUT_HEADER_SIZE;
  const totalSize = headerSize + paramsSize + msg.payload.payload.length;
  const result = new Uint8Array(totalSize);

  // Header: [1B payloadType][8B timestamp BE][4B paramsSize BE]
  result[0] = payloadType;
  writeUint32BE(result, 1, 0); // high 32 bits (timestamp ms fits in low 32)
  writeUint32BE(result, 5, timestamp);
  writeUint32BE(result, 9, paramsSize);

  result.set(paramsBytes, headerSize);
  result.set(msg.payload.payload, headerSize + paramsSize);

  return result;
}

/** Deserialize bytes into an InteractionInputMessage (isomorphic). */
export function deserializeInteractionInputMessage(data: Uint8Array): InteractionInputMessage {
  if (data.length < INTERACTION_INPUT_HEADER_SIZE) {
    throw new Error("Invalid data: message too short for interaction input header");
  }

  const payloadTypeInt = data[0];
  const timestamp = readUint32BE(data, 5);
  const paramsSize = readUint32BE(data, 9);

  let currentPos = INTERACTION_INPUT_HEADER_SIZE;
  let params: Record<string, unknown> | null = null;

  if (paramsSize > 0) {
    const paramsBytes = data.subarray(currentPos, currentPos + paramsSize);
    try {
      params = JSON.parse(new TextDecoder().decode(paramsBytes));
    } catch {
      // Leave params as null on parse failure
    }
    currentPos += paramsSize;
  }

  const payloadBytes = new Uint8Array(data.subarray(currentPos));
  const payloadType = payloadTypeToStr(payloadTypeInt);

  return {
    type: MessageType.InteractionInput,
    payload: {
      payloadType,
      payload: payloadBytes,
      timestamp,
      params,
    },
  };
}

/** Serialize an InteractionResponseMessage to bytes (isomorphic). */
export function serializeInteractionResponseMessage(msg: InteractionResponseMessage): Uint8Array {
  const interactionIdBytes = uuidToBytes(msg.payload.interactionId);
  const isFinalFlag = msg.payload.isFinalResponse ? 1 : 0;

  // Calculate total size
  let totalSize = INTERACTION_RESPONSE_HEADER_SIZE;
  for (const entry of msg.payload.payloads) {
    totalSize += PAYLOAD_ENTRY_HEADER_SIZE + entry.data.length;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;

  result[offset] = isFinalFlag;
  offset += 1;
  result.set(interactionIdBytes, offset);
  offset += 16;
  writeUint32BE(result, offset, 0); // high 32 bits
  offset += 4;
  writeUint32BE(result, offset, msg.payload.timestamp);
  offset += 4;
  writeUint32BE(result, offset, msg.payload.usage);
  offset += 4;
  writeUint32BE(result, offset, msg.payload.index);
  offset += 4;
  writeUint32BE(result, offset, msg.payload.payloads.length);
  offset += 4;

  for (const entry of msg.payload.payloads) {
    const pt = payloadTypeFromStr(entry.payloadType);
    writeUint32BE(result, offset, entry.data.length);
    offset += 4;
    result[offset] = pt;
    offset += 1;
    result.set(entry.data, offset);
    offset += entry.data.length;
  }

  return result;
}

/** Deserialize bytes into an InteractionResponseMessage (isomorphic). */
export function deserializeInteractionResponseMessage(
  data: Uint8Array,
): InteractionResponseMessage {
  if (data.length < INTERACTION_RESPONSE_HEADER_SIZE) {
    throw new Error("Invalid data: message too short for interaction response header");
  }

  const isFinalFlag = data[0];
  const interactionIdBytes = data.subarray(1, 17);
  const timestamp = readUint32BE(data, 21);
  const usage = readUint32BE(data, 25);
  const index = readUint32BE(data, 29);
  const numPayloads = readUint32BE(data, 33);

  const interactionId = bytesToUuid(interactionIdBytes);
  const isFinalResponse = Boolean(isFinalFlag);

  let offset = INTERACTION_RESPONSE_HEADER_SIZE;
  const payloads: InteractionResponsePayload[] = [];

  for (let i = 0; i < numPayloads; i++) {
    if (data.length < offset + PAYLOAD_ENTRY_HEADER_SIZE) {
      throw new Error("Invalid data: truncated payload entry header");
    }
    const dataSize = readUint32BE(data, offset);
    const payloadTypeInt = data[offset + 4];
    offset += PAYLOAD_ENTRY_HEADER_SIZE;

    if (data.length < offset + dataSize) {
      throw new Error("Invalid data: truncated payload entry body");
    }
    const payloadData = new Uint8Array(data.subarray(offset, offset + dataSize));
    offset += dataSize;

    payloads.push({
      payloadType: payloadTypeToStr(payloadTypeInt),
      data: payloadData,
    });
  }

  return {
    type: MessageType.InteractionResponse,
    payload: {
      interactionId,
      payloads,
      isFinalResponse,
      timestamp,
      usage,
      index,
    },
  };
}
