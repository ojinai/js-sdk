/**
 * Node WebSocket transport (server-side only).
 *
 * @ojinai/js-sdk v1.0 is a Node-only SDK. Apps must consume this from their
 * own backend and expose their own client-facing transport. The SDK must not
 * be loaded in a browser or any untrusted runtime; no browser WebSocket
 * implementation is shipped. See PLAN.md §2.2 and §4.1.
 *
 * This module re-exports {@link WSTransport} and delegates
 * {@link createWSTransport} to the heartbeat-enabled {@link NodeWSTransport}
 * in `ws-transport-node.ts`. The duplicate inline implementation that
 * previously lived here has been removed to avoid divergence (ost-q6x3).
 */

import {
  createNodeWSTransport,
  type NodeWSTransportOptions,
  type WSTransport,
} from "./ws-transport-node.js";

export type { WSTransport };

/**
 * Create the default Node.js WebSocket transport backed by the `ws` package.
 *
 * Delegates to {@link createNodeWSTransport} which includes the
 * client-originated heartbeat ping logic (ost-q6x3 / PLAN.md §5.2). The
 * interval is `.unref()`'d so it never holds the Node event loop open past
 * `close()`.
 *
 * Intended for use by {@link OjinClient}. Pass the returned instance as
 * `options.transport` when constructing a client, or rely on the default
 * created automatically by {@link OjinClient}.
 *
 * @param options - Optional heartbeat interval (default: `30_000` ms) and
 *   logger forwarded to {@link NodeWSTransport}.
 */
export function createWSTransport(options?: NodeWSTransportOptions): WSTransport {
  return createNodeWSTransport(options);
}
