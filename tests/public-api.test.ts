import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import * as protocol from "../src/protocol/index.js";
import * as profiling from "../src/utils/profiling.js";
import * as uuid from "../src/utils/uuid.js";

describe("root public API", () => {
  it("keeps v1 SDK symbols on the root export", () => {
    expect(sdk.OjinClient).toBeTypeOf("function");
    expect(sdk.OjinEvent).toBeTypeOf("object");
    expect(sdk.ConnectionState).toBeTypeOf("object");
    expect(sdk.DisconnectReason).toBeTypeOf("object");
    expect(sdk.OjinEventEmitter).toBeTypeOf("function");
    expect(sdk.OjinAudioInputMessage).toBeTypeOf("function");
    expect(sdk.OjinInteractionResponseMessage).toBeTypeOf("function");
    expect(sdk.FrameType).toBeTypeOf("object");
    expect(sdk.OjinError).toBeTypeOf("function");
    expect(sdk.OjinErrorCode).toBeTypeOf("object");
    expect(sdk.createConsoleLogger).toBeTypeOf("function");
    expect(sdk.version).toBe("1.0.0-rc");
  });

  it("does not expose protocol, profiling, uuid, or transport internals from root", () => {
    expect("MessageType" in sdk).toBe(false);
    expect("PayloadType" in sdk).toBe(false);
    expect("serializeInteractionInputMessage" in sdk).toBe(false);
    expect("serializeInteractionResponseMessage" in sdk).toBe(false);
    expect("deserializeInteractionInputMessage" in sdk).toBe(false);
    expect("deserializeInteractionResponseMessage" in sdk).toBe(false);
    expect("FPSTracker" in sdk).toBe(false);
    expect("LatencyTracker" in sdk).toBe(false);
    expect("uuidToBytes" in sdk).toBe(false);
    expect("bytesToUuid" in sdk).toBe(false);
    expect("NIL_UUID" in sdk).toBe(false);
    expect("createWSTransport" in sdk).toBe(false);
  });

  it("keeps internals available from their subpaths", () => {
    expect(protocol.MessageType).toBeTypeOf("object");
    expect(protocol.PayloadType).toBeTypeOf("object");
    expect(protocol.serializeInteractionInputMessage).toBeTypeOf("function");
    expect(protocol.serializeInteractionResponseMessage).toBeTypeOf("function");
    expect(profiling.FPSTracker).toBeTypeOf("function");
    expect(profiling.LatencyTracker).toBeTypeOf("function");
    expect(uuid.uuidToBytes).toBeTypeOf("function");
    expect(uuid.bytesToUuid).toBeTypeOf("function");
  });
});
