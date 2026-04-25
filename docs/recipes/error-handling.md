# Recipe: Error handling at the right granularity

All SDK errors extend {@link index.OjinError | OjinError} and carry a typed
`.code: OjinErrorCode` field plus optional `.details`. Errors surface in two
distinct places:

1. **Thrown synchronously** from `connect()` and `waitForReady()`.
2. **Emitted** via `OjinEvent.Error` for runtime errors that arrive after the
   session is established.

## When to use `instanceof` vs `.code`

Use `instanceof` for **typed subclasses** that exist in the SDK — these cover
the most important branching decisions (retryable vs not, auth vs
infrastructure). Fall back to `.code` only when the SDK has no typed subclass
for a particular error code.

| Typed class | Codes it covers | Retryable? |
|-------------|-----------------|------------|
| `AuthError` | `AUTH_FAILED`, `UNAUTHORIZED`, `INVALID_HEADERS` | No |
| `RateLimitError` | `RATE_LIMITED` | Yes, with backoff |
| `BackendUnavailableError` | `BACKEND_UNAVAILABLE` | Yes, with backoff |
| `ReadyTimeoutError` | `READY_TIMEOUT` | Yes, reconnect |
| `ConnectionError` | `CONNECTION_FAILED`, `NOT_CONNECTED` | Depends |
| *(use `.code`)* | `INTERNAL_ERROR`, `FRAME_SIZE_EXCEEDED`, etc. | Varies |

## Code

Register the error handler **before** `connect()` so no runtime errors are
missed during session setup. Connection-time errors (auth failures on
`connect()` / `waitForReady()`) are separate — catch them with a try/catch
as shown below.

```typescript
import {
  OjinClient,
  OjinEvent,
  AuthError,
  RateLimitError,
  BackendUnavailableError,
  OjinError,
  OjinErrorCode,
} from "@ojinai/js-sdk";

const client = new OjinClient({
  wsUrl: process.env.OJIN_WS_URL!,
  apiKey: process.env.OJIN_API_KEY!,
  configId: process.env.OJIN_CONFIG_ID!,
});

// Runtime errors arrive via the error event (after the session is established).
client.events.on(OjinEvent.Error, (err: OjinError) => {
  if (err instanceof AuthError) {
    console.error("Auth error — not retryable:", err.code, err.message);
    process.exit(1);
  } else if (err instanceof RateLimitError) {
    console.warn("Rate limited — back off before retrying");
  } else if (err instanceof BackendUnavailableError) {
    console.warn("Backend unavailable — retry later");
  } else if (err.code === OjinErrorCode.InternalError) {
    console.error("Server fault:", err.details);
  } else {
    console.error("Ojin error:", err.code, err.message);
  }
});

await client.connect();
await client.waitForReady();
```

Connection-time errors (thrown by `connect()` and `waitForReady()`) must be
handled with a try/catch:

```ts
try {
  await client.connect();
  await client.waitForReady();
} catch (err) {
  if (err instanceof AuthError) {
    console.error("Auth failed — check API key:", err.message);
    process.exit(1);
  }
  throw err; // re-throw anything you don't handle explicitly
}
```

## Notes

- **Register `OjinEvent.Error` before `connect()`** to avoid missing errors
  that arrive during session setup (e.g. `MISSING_CONFIG_ID` from the server).
- **`CANCELLED` is not an error.** The SDK consumes `CANCELLED` server
  messages silently; your error handler will not see them. See the
  [interruption recipe](handle-interruption.md).
- **`err.details`** is typed as `unknown`. Cast or narrow it before use:
  `const d = err.details as Record<string, unknown>`.
- **Connection-time vs runtime.** `connect()` and `waitForReady()` throw
  synchronously (via rejected promise) for conditions that prevent the session
  from starting. Once the session is established, errors arrive only via
  `OjinEvent.Error`.
- **Do not catch all errors at the top level without re-throwing.** If you
  swallow an `AuthError` from `waitForReady()`, the session will appear ready
  when it is not. Always `throw err` for errors you do not handle explicitly.
