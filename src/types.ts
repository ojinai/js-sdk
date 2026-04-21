/** Connection state of the OjinClient. */
export enum ConnectionState {
  Disconnected = "disconnected",
  Connecting = "connecting",
  Connected = "connected",
  Disconnecting = "disconnecting",
}

/** Configuration options for the OjinClient constructor. */
export interface OjinClientOptions {
  /** WebSocket URL of the OJIN STV service */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Configuration ID for the persona */
  configId: string;
  /** Number of reconnection attempts on failure (default: 3) */
  reconnectAttempts?: number;
  /** Delay between reconnection attempts in seconds (default: 1.0) */
  reconnectDelay?: number;
  /** Optional mode string (e.g., "dev" for development mode) */
  mode?: string | null;
}
