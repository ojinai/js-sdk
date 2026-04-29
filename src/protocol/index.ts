/**
 * @ojinai/js-sdk/protocol
 *
 * Low-level binary serialization helpers and the raw wire-protocol enums.
 * Consumer code that only needs high-level interaction should import from the
 * default entry `@ojinai/js-sdk` instead.
 */

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
} from "./interaction-messages.js";
export {
  deserializeInteractionInputMessage,
  deserializeInteractionResponseMessage,
  PayloadType,
  payloadTypeFromStr,
  payloadTypeToStr,
  serializeInteractionInputMessage,
  serializeInteractionResponseMessage,
} from "./interaction-messages.js";
export type {
  SessionReadyMessage,
  SessionReadyPayload,
  SessionSetupMessage,
  SessionSetupPayload,
  SessionSetupPing,
  SessionUpdateMessage,
  SessionUpdatePayload,
} from "./session-messages.js";
export { MessageType } from "./session-messages.js";
