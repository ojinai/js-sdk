import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  ConnectionState,
  OjinAudioInputMessage,
  OjinClient,
} from "../../src/index.js";
import { OjinSessionReadyMessage } from "../../src/protocol/client-messages.js";
import { deserializeInteractionInputMessage } from "../../src/protocol/interaction-messages.js";

interface OjinClientTestInternals {
  _connectionState: ConnectionState;
  _inferenceServerReady: boolean;
  _lastSessionReady: OjinSessionReadyMessage | null;
  audioChunkSize: number;
  transport: {
    isOpen: boolean;
    send(data: Uint8Array | string): void;
    close(): void;
  } | null;
}

function makeClient(overrides?: Partial<ConstructorParameters<typeof OjinClient>[0]>): OjinClient {
  return new OjinClient({
    wsUrl: "ws://127.0.0.1:65530",
    apiKey: "test-api-key",
    configId: "test-config-id",
    ...overrides,
  });
}

describe("OjinClient audioChunkSize", () => {
  it("defaults audioChunkSize to 500_000 bytes", () => {
    const client = makeClient();
    const internals = client as unknown as OjinClientTestInternals;

    expect(internals.audioChunkSize).toBe(500_000);
  });

  it("throws ConfigurationError when audioChunkSize is below 1024 bytes", () => {
    expect(() => makeClient({ audioChunkSize: 1_023 })).toThrow(ConfigurationError);
  });

  it("accepts audioChunkSize at the lower bound", () => {
    expect(() => makeClient({ audioChunkSize: 1_024 })).not.toThrow();
  });

  it("accepts audioChunkSize at the upper bound", () => {
    expect(() => makeClient({ audioChunkSize: 512_000 })).not.toThrow();
  });

  it("throws ConfigurationError when audioChunkSize exceeds 512_000 bytes", () => {
    expect(() => makeClient({ audioChunkSize: 513_000 })).toThrow(ConfigurationError);
  });

  it("chunks audio using the configured audioChunkSize", async () => {
    const client = makeClient({ audioChunkSize: 1_024 });
    const internals = client as unknown as OjinClientTestInternals;
    const sentFrames: Uint8Array[] = [];

    internals._connectionState = ConnectionState.Connected;
    internals._inferenceServerReady = true;
    internals._lastSessionReady = new OjinSessionReadyMessage({});
    internals.transport = {
      isOpen: true,
      send(data) {
        sentFrames.push(data as Uint8Array);
      },
      close() {
        this.isOpen = false;
      },
    };

    await client.sendMessage(new OjinAudioInputMessage(new Uint8Array(2_500)));

    expect(sentFrames).toHaveLength(3);
    expect(deserializeInteractionInputMessage(sentFrames[0]).payload.payload).toHaveLength(1_024);
    expect(deserializeInteractionInputMessage(sentFrames[1]).payload.payload).toHaveLength(1_024);
    expect(deserializeInteractionInputMessage(sentFrames[2]).payload.payload).toHaveLength(452);
  });
});
