/** Enum for WebSocket message types. */
export enum MessageType {
  // Client -> Proxy Messages
  EndInteraction = "endInteraction",
  InteractionInput = "interactionInput",
  SessionUpdate = "sessionUpdate",
  CancelInteraction = "cancelInteraction",

  // Proxy -> Client Messages
  SessionReady = "sessionReady",
  InteractionResponse = "interactionResponse",
  ErrorResponse = "errorResponse",

  // Proxy -> Inference Server Messages
  SessionSetup = "sessionSetup",
  SessionPing = "sessionPing",
}

/** Payload for session setup messages. */
export interface SessionSetupPayload {
  modelId: string;
  traceId: string;
  modelConfigId: string;
  apiKeyId: string;
  parameters?: Record<string, unknown> | null;
  timestamp?: number | null;
}

/** Payload for session update messages. */
export interface SessionUpdatePayload {
  parameters?: Record<string, unknown> | null;
  timestamp?: number | null;
}

/** Payload for session ready messages. */
export interface SessionReadyPayload {
  traceId: string;
  status: string;
  load: number;
  timestamp?: number | null;
  parameters?: Record<string, unknown> | null;
  numClients?: number;
  maxCapacity?: number;
}

/** Session setup message sent from client to proxy. */
export interface SessionSetupMessage {
  type: MessageType.SessionSetup;
  payload: SessionSetupPayload;
}

/** Session update message sent from client to proxy. */
export interface SessionUpdateMessage {
  type: MessageType.SessionUpdate;
  payload: SessionUpdatePayload;
}

/** Session ready message sent from proxy to client. */
export interface SessionReadyMessage {
  type: MessageType.SessionReady;
  payload: SessionReadyPayload;
}

/** Session setup ping message. */
export interface SessionSetupPing {
  type: MessageType.SessionPing;
}
