/**
 * Isomorphic WebSocket transport interface.
 *
 * In the browser, this wraps the native `WebSocket` API.
 * In Node.js, this wraps the `ws` package.
 * The OjinClient only depends on this interface, keeping
 * the rest of the code platform-agnostic.
 */

/** Platform-agnostic WebSocket transport. */
export interface WSTransport {
  /** Connect to the server at the given URL. */
  connect(url: string, headers: Record<string, string>): Promise<void>;
  /** Send a string or binary message. */
  send(data: string | Uint8Array): void;
  /** Close the connection. */
  close(): void;
  /** Register a handler for incoming messages. */
  onMessage(handler: (data: Uint8Array, isBinary: boolean) => void): void;
  /** Register a handler for connection close events. */
  onClose(handler: (code: number, reason: string) => void): void;
  /** Register a handler for connection errors. */
  onError(handler: (err: Error) => void): void;
  /** Whether the underlying socket is open. */
  readonly isOpen: boolean;
  /** Enable TCP_NODELAY for lower latency (no-op in browser). */
  setNoDelay(): void;
}

/** Create a WebSocket transport for the current platform. */
export async function createWSTransport(): Promise<WSTransport> {
  if (isBrowser()) {
    return new BrowserWSTransport();
  }
  const { NodeWSTransport } = await import("./ws-transport-node.js");
  return new NodeWSTransport();
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.WebSocket !== "undefined";
}

/** Browser WebSocket transport using the native WebSocket API. */
class BrowserWSTransport implements WSTransport {
  private ws: WebSocket | null = null;
  private messageHandler: ((data: Uint8Array, isBinary: boolean) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(url: string, _headers: Record<string, string>): Promise<void> {
    // Browser WebSocket doesn't support custom headers.
    // Auth must be passed via URL params or subprotocol.
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (ev: Event) => {
        cleanup();
        const err = new Error(`WebSocket error: ${ev.type}`);
        reject(err);
        if (this.errorHandler) this.errorHandler(err);
      };

      const onClose = (ev: CloseEvent) => {
        cleanup();
        if (this.closeHandler) this.closeHandler(ev.code, ev.reason);
      };

      const onMessage = (ev: MessageEvent) => {
        if (!this.messageHandler) return;
        if (ev.data instanceof ArrayBuffer) {
          this.messageHandler(new Uint8Array(ev.data), true);
        } else if (typeof ev.data === "string") {
          this.messageHandler(new TextEncoder().encode(ev.data), false);
        } else if (ev.data instanceof Blob) {
          ev.data.arrayBuffer().then((buf: ArrayBuffer) => {
            if (this.messageHandler) this.messageHandler(new Uint8Array(buf), true);
          });
        }
      };

      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("message", onMessage);
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);

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
    // No-op in browser — TCP_NODELAY is not available
  }
}
