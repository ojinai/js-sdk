/**
 * Node.js WebSocket transport using the `ws` package.
 * This module is only imported at runtime on Node.js.
 */

import WebSocket from "ws";
import type { WSTransport } from "./ws-transport.js";

export class NodeWSTransport implements WSTransport {
  private ws: WebSocket | null = null;
  private messageHandler: ((data: Uint8Array, isBinary: boolean) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(url: string, headers: Record<string, string>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });

      ws.on("open", () => resolve());
      ws.on("error", (err: Error) => {
        reject(err);
        this.errorHandler?.(err);
      });
      ws.on("close", (code: number, reason: Buffer) => {
        this.closeHandler?.(code, reason.toString("utf-8"));
      });
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (this.messageHandler) {
          const bytes =
            data instanceof Buffer
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : new Uint8Array(data as ArrayBuffer);
          this.messageHandler(bytes, isBinary);
        }
      });

      this.ws = ws;
    });
  }

  send(data: string | Uint8Array): void {
    if (!this.ws) throw new Error("WebSocket not connected");
    this.ws.send(data);
  }

  close(): void {
    this.ws?.close();
  }

  onMessage(handler: (data: Uint8Array, isBinary: boolean) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  setNoDelay(): void {
    if (!this.ws) return;
    try {
      const socket = (this.ws as any)._socket;
      if (socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true);
      }
    } catch {
      // Ignore TCP_NODELAY failures
    }
  }
}
