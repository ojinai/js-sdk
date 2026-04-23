# Agent Instructions — Ojin JS SDK

This file is the coding-agent contract for the `@ojinai/js-sdk` project.
Read it before writing or modifying code.

## Project overview

Node.js / server-side TypeScript SDK for the Ojin Speech-To-Video WebSocket
service. **Node-only — never add browser or React Native code paths.**

## Non-negotiable rules

- No `console.*` in `src/` except `src/utils/logger.ts`.
- No raw `setTimeout`/`setInterval` in `src/` except the four allowlisted files
  (`src/utils/backoff.ts`, `src/utils/sleep.ts`,
  `src/utils/page-lifecycle.ts`, `src/ws-transport-node.ts`).
- No direct browser WebSocket usage; the integration pattern is
  `Frontend ⇄ Your backend (this SDK) ⇄ Ojin`.

## Code style

- Biome is the linter/formatter — run `pnpm lint:check` before committing.
- TypeScript strict mode; no `any` without a comment justifying it.
- All new public types and functions require JSDoc.

## Testing

- `pnpm test` runs the full Vitest suite; all tests must pass before merging.
- Write negative-path tests for every guard that throws a `ConfigurationError`.
- Tests live under `tests/` and mirror the `src/` directory structure.

## Commit guidance

- Follow the existing commit style (`type(scope): message`).
- Never amend a commit that is already on the remote branch.


<claude-mem-context>
# Memory Context

# [js-sdk] recent context, 2026-04-23 8:28pm GMT+2

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (22,376t read) | 1,437,625t work | 98% savings

### Apr 23, 2026
406 6:29p 🟣 RATE_LIMITED Single-Retry with 200ms Abortable Backoff — js-sdk ost-v2y5
408 6:32p 🟣 RATE_LIMITED Single-Retry with 200ms Abortable Backoff
409 " 🟣 Abortable Sleep Primitive in OjinClient
410 " 🟣 Typed Error Class Hierarchy with Server-Code Mapping
411 " 🟣 NodeWSTransport with Unref'd Heartbeat Pings
412 " 🟣 CI Benchmark Regression Gate and Timer Ownership Guard-Rails
413 " 🟣 URL Builder with URLSearchParams for Safe Percent-Encoding
414 6:33p 🟣 rateLimitRetry.test.ts: All 3 Acceptance Criteria Tests Pass
531 7:28p 🔵 ojin-client (js-sdk) Quality Gates: Full Stack Confirmed
589 7:55p 🔵 Ojin TS SDK v1.0: Remaining Open Tickets and Implementation Gap Analysis
592 " 🔵 Ojin TS SDK: ojin-client.ts Implementation State — What Exists vs. What Must Be Built
594 " ⚖️ Codex-Team Wave Strategy: Merge ost-m2t5+ost-n3u7 Into One Agent, ost-m1p4 Parallel
596 7:56p 🔵 Ojin TS SDK js-sdk: ost-m2t5 Reconnect State Machine — Ticket In-Progress, Events Not Yet Implemented
597 " 🔵 Ojin TS SDK js-sdk: ost-n3u7 Inbound-Idle Check — Ticket In-Progress, Types Partially Implemented
598 " 🔵 Ojin TS SDK js-sdk: Large Uncommitted Changeset Across 35+ Files
599 " 🔵 Ojin TS SDK js-sdk: OjinClientOptions in src/types.ts — Full v1.0 API Surface Confirmed
601 7:58p 🔵 Ojin JS SDK v1.0 Codebase State: Complete API Surface Confirmed for CHANGELOG Authoring
603 " 🔵 Ojin JS SDK v0.1 → v1.0 Complete Breaking Changes Inventory from PLAN.md §11.1
606 8:00p 🔵 ConnectionClosed Event Confirmed Two-Arg (Not Object Form); DisconnectReason Not Implemented
605 " 🔵 Codex Agent Wait Timed Out After 120s — Bohr and Euclid Still Running
607 " ✅ CHANGELOG.md Created for Ojin TS SDK v1.0 (ost-m1p4)
608 " 🟣 CHANGELOG.md Created for Ojin JS SDK v1.0.0 (ticket ost-m1p4)
609 " ✅ CHANGELOG.md Content Verified: Full v0.1→v1.0 Migration Record with 7 Breaking Changes
613 8:02p 🔵 js-sdk OjinClient.handleClose() Has No Reconnect Logic — ost-m2t5 Not Yet Wired
614 " 🔵 js-sdk connect() Loop Uses Hardcoded Legacy Values Instead of OjinClientOptions
615 " 🔵 js-sdk OjinErrorCode Enum and Error Class Hierarchy — Complete v1.0 Implementation Confirmed
616 " 🔵 js-sdk Heartbeat Tests Comprehensive for NodeWSTransport; Inbound-Idle (ost-n3u7) Has Zero Tests
617 " 🔵 js-sdk Package Version Still at 0.1.0 — v1.0 Release Epic Not Complete
618 8:04p 🟣 js-sdk: ConnectionState.Reconnecting and OjinEvent Reconnecting/Reconnected Added to Public API
619 " 🔴 js-sdk: connect() Fixed to Read initialConnectAttempts and initialConnectDelayMs from Options
620 " 🟣 js-sdk: Full Auto-Reconnect State Machine Implemented in OjinClient
621 " 🟣 js-sdk: Inbound-Idle Wall-Clock Tracking Implemented in OjinClient (ost-n3u7)
622 " 🔄 js-sdk: close() and handleClose() Refactored with Helper Methods for Throttle Queue and Rate-Limit State
627 8:05p 🟣 js-sdk: reconnect.test.ts Created — 6 Integration Tests for Reconnect State Machine
628 " ✅ js-sdk reconnect.test.ts: Last Test Case Removed — sendMessage-during-failure Rejection Test Dropped
632 8:07p 🟣 js-sdk: liveness.test.ts Created — 3 Unit Tests for Inbound-Idle Wall-Clock Check (ost-n3u7)
633 " 🔵 js-sdk reconnect.test.ts: Two Test Failures Revealing Counter-Reset and Exhaustion Bugs
634 " 🔴 js-sdk reconnect.test.ts: Counter-Reset Race Fixed — terminate() Now Called from SessionReady Event Handler
637 8:09p 🟣 ost-m2t5 + ost-n3u7 Implemented: Full Reconnect State Machine and Inbound-Idle Check
639 " 🟣 ost-m2t5 + ost-n3u7 Implementation Complete with One Flaky Test Remaining
642 8:11p 🔵 Reconnect Loop Race Condition: latestSocket Reference Mutated Before Delayed terminate()
644 8:12p 🔴 Transport Ghost Callback Bug Fixed: Old Socket Events Bleeding Into New Connection
645 8:13p 🔵 Reconnect Counter Reset Bug Persists: Both Test Fix and Runtime Guard Ineffective
646 " 🔵 Reconnect Counter Reset Debug: State at session.ready #1 is Clean, Issue Occurs After
652 8:15p 🔵 Reconnect Failure Counter Bug Traced: Exact State Sequence Captured via Debug Logging
664 8:21p ⚖️ User Preference: Commit Related File Changes in Groups
665 " 🔵 Ojin JS SDK: Large Uncommitted Changeset Across Core, Tests, and Config
669 8:23p 🟣 Ojin JS SDK v1.0: Legacy Config Options Removed, Migration Guards Added
670 " 🟣 Ojin JS SDK: HTTP Upgrade Failure Classification with AuthError vs ConnectionError
671 " ✅ Ojin JS SDK: CHANGELOG.md and Migration Guide Added for v1.0

Access 1438k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>