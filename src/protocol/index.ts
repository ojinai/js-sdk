/**
 * @ojinai/js-sdk/protocol
 *
 * Low-level binary serialization helpers and the raw wire-protocol enums.
 * Consumer code that only needs high-level interaction should import from the
 * default entry `@ojinai/js-sdk` instead.
 */
export {
  deserializeInteractionResponseMessage,
  PayloadType,
  payloadTypeFromStr,
  payloadTypeToStr,
  serializeInteractionInputMessage,
} from "./interaction-messages.js";
export { MessageType } from "./session-messages.js";
