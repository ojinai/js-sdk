/**
 * Compile-time type tests for the OjinClientMessage / OjinServerMessage split.
 *
 * These assertions are checked by `pnpm typecheck` (tsc --noEmit) and verify
 * that the type system enforces the sender/receiver distinction:
 *  - OjinClient.sendMessage accepts OjinClientMessage
 *  - OjinClient.sendMessage rejects OjinServerMessage
 */
import { expectTypeOf } from "vitest";
import type { OjinClient } from "../../src/ojin-client.js";
import type { OjinClientMessage, OjinServerMessage } from "../../src/protocol/client-messages.js";

// The first parameter of sendMessage must be an OjinClientMessage.
expectTypeOf<Parameters<OjinClient["sendMessage"]>[0]>().toMatchTypeOf<OjinClientMessage>();

// An OjinServerMessage must NOT be accepted by sendMessage.
expectTypeOf<Parameters<OjinClient["sendMessage"]>[0]>().not.toMatchTypeOf<OjinServerMessage>();
