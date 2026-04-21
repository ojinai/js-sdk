/**
 * Node WebSocket transport (server-side only).
 *
 * @ojinai/js-sdk v1.0 is a Node-only SDK. Apps must consume this from their
 * own backend and expose their own client-facing transport. The SDK must not
 * be loaded in a browser or any untrusted runtime; no browser WebSocket
 * implementation is shipped. See PLAN.md §2.2 and §4.1.
 */

import WebSocket from "ws";

export interface WSTransport {
  connect(url: string, headers: Record<string, string>): Promise<void>;
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: Uint8Array, isBinary: boolean) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (err: Error) => void): void;
  readonly isOpen: boolean;
  setNoDelay(): void;
}

class NodeWSTransport implements WSTransport {
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
      const socket = (this.ws as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })
        ._socket;
      socket?.setNoDelay?.(true);
    } catch {
      // Ignore TCP_NODELAY failures; not critical.
    }
  }
}

export function createWSTransport(): WSTransport {
  return new NodeWSTransport();
}
