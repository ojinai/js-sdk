// Version

// Errors
export { ConnectionError, OjinError, OjinErrorCode, ProtocolError } from "./errors.js";
export type { OjinEventCallbacks } from "./events.js";
// Events
export { OjinEvent, OjinEventEmitter } from "./events.js";
// Client
export { OjinClient } from "./ojin-client.js";
// Protocol: client messages
export {
  FrameType,
  OjinAudioInputMessage,
  OjinCancelInteractionMessage,
  OjinClientMessage,
  OjinEndInteractionMessage,
  OjinErrorResponseMessage,
  OjinInteractionResponseMessage,
  OjinMessage,
  OjinServerMessage,
  OjinSessionReadyMessage,
  OjinTextInputMessage,
} from "./protocol/client-messages.js";
export type {
  CancelInteractionInput,
  CancelInteractionMessage,
  EndInteraction,
  EndInteractionMessage,
  ErrorResponse,
  ErrorResponseMessage,
  InteractionInput,
  InteractionInputMessage,
  InteractionResponse,
  InteractionResponseMessage,
  InteractionResponsePayload,
} from "./protocol/interaction-messages.js";
// Protocol: interaction messages
export {
  deserializeInteractionInputMessage,
  deserializeInteractionResponseMessage,
  PayloadType,
  payloadTypeFromStr,
  payloadTypeToStr,
  serializeInteractionInputMessage,
  serializeInteractionResponseMessage,
} from "./protocol/interaction-messages.js";
export type {
  SessionReadyMessage,
  SessionReadyPayload,
  SessionSetupMessage,
  SessionSetupPayload,
  SessionSetupPing,
  SessionUpdateMessage,
  SessionUpdatePayload,
} from "./protocol/session-messages.js";
// Protocol: session messages
export { MessageType } from "./protocol/session-messages.js";
export type { OjinClientOptions } from "./types.js";
// Types
export { ConnectionState } from "./types.js";
// Profiling
export { FPSTracker, LatencyTracker } from "./utils/profiling.js";
// UUID utilities
export { bytesToUuid, NIL_UUID, uuidToBytes } from "./utils/uuid.js";
export { version } from "./version.js";

// WebSocket transport (for advanced use)
export type { WSTransport } from "./ws-transport.js";
export { createWSTransport } from "./ws-transport.js";
