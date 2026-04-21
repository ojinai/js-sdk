/**
 * Mock WebSocket inference proxy for integration testing.
 * Mimics the Python FastAPI mock server.
 */
import { type WebSocket, WebSocketServer } from "ws";
import {
  deserializeInteractionInputMessage,
  type InteractionResponseMessage,
  type InteractionResponsePayload,
  serializeInteractionResponseMessage,
} from "../../src/protocol/interaction-messages.js";
import { MessageType } from "../../src/protocol/session-messages.js";

export class MockInferenceProxy {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.sendSessionReady(ws);
      ws.on("message", (data, isBinary) => this.handleMessage(ws, data, isBinary));
      ws.on("close", () => this.clients.delete(ws));
    });
  }

  private sendSessionReady(ws: WebSocket): void {
    const msg = {
      type: MessageType.SessionReady,
      payload: {
        traceId: "test-trace",
        status: "success",
        load: 0.5,
        timestamp: Date.now(),
        parameters: { test: "mock_parameters" },
      },
    };
    ws.send(JSON.stringify(msg));
  }

  private handleMessage(
    ws: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean,
  ): void {
    if (isBinary) {
      // Parse interaction input and send a mock response
      try {
        const _inputMsg = deserializeInteractionInputMessage(new Uint8Array(data as Buffer));
        const testVideoBytes = new Uint8Array([0, 1, 2, 3, 4, 5].map((_, i) => i * 10));
        const interactionResponse: InteractionResponseMessage = {
          type: MessageType.InteractionResponse,
          payload: {
            interactionId: "550e8400-e29b-41d4-a716-446655440000",
            payloads: [
              { payloadType: "image", data: testVideoBytes } as InteractionResponsePayload,
              { payloadType: "audio", data: testVideoBytes } as InteractionResponsePayload,
            ],
            isFinalResponse: false,
            timestamp: Date.now(),
            index: 0,
            usage: 1,
          },
        };
        ws.send(serializeInteractionResponseMessage(interactionResponse));
      } catch (err) {
        console.error("Mock server: error handling binary message:", err);
      }
      return;
    }

    // Text messages (JSON)
    const text = data.toString("utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(ws, "Invalid JSON format");
      return;
    }

    const msgType = parsed.type as string;

    if (msgType === MessageType.CancelInteraction) {
      // Acknowledge cancel — send a final response
      const interactionResponse: InteractionResponseMessage = {
        type: MessageType.InteractionResponse,
        payload: {
          interactionId: "550e8400-e29b-41d4-a716-446655440000",
          payloads: [
            { payloadType: "image", data: new Uint8Array(0) } as InteractionResponsePayload,
          ],
          isFinalResponse: true,
          timestamp: Date.now(),
          index: 0,
          usage: 1,
        },
      };
      ws.send(serializeInteractionResponseMessage(interactionResponse));
      return;
    }

    if (msgType === MessageType.EndInteraction) {
      const interactionResponse: InteractionResponseMessage = {
        type: MessageType.InteractionResponse,
        payload: {
          interactionId: "550e8400-e29b-41d4-a716-446655440000",
          payloads: [
            { payloadType: "image", data: new Uint8Array(0) } as InteractionResponsePayload,
          ],
          isFinalResponse: true,
          timestamp: Date.now(),
          index: 0,
          usage: 1,
        },
      };
      ws.send(serializeInteractionResponseMessage(interactionResponse));
      return;
    }

    this.sendError(ws, `Unknown message type: ${msgType}`);
  }

  private sendError(ws: WebSocket, message: string): void {
    const msg = {
      type: MessageType.ErrorResponse,
      payload: {
        code: "UNKNOWN_ERROR",
        message,
        timestamp: Date.now(),
      },
    };
    ws.send(JSON.stringify(msg));
  }

  /** Close the mock server. */
  async close(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Get the port the server is listening on. */
  get address(): string {
    const addr = this.wss.address();
    if (typeof addr === "string") return addr;
    return `ws://127.0.0.1:${(addr as any).port}`;
  }
}
