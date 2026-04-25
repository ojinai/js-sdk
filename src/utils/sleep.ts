/** Handle returned by the SDK-owned timeout scheduler. */
export type TimeoutHandle = ReturnType<typeof setTimeout>;

/**
 * Schedule a one-shot timer.
 *
 * Centralizing timeout creation keeps raw timer ownership out of shared SDK
 * modules while preserving the platform timer semantics.
 */
export function scheduleTimeout(callback: () => void, delayMs: number): TimeoutHandle {
  return setTimeout(callback, delayMs);
}

/** Clear a timer scheduled with {@link scheduleTimeout}. */
export function clearScheduledTimeout(handle: TimeoutHandle): void {
  clearTimeout(handle);
}

/**
 * Resolve after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    scheduleTimeout(resolve, ms);
  });
}

/**
 * Resolve after `ms` milliseconds, or reject when the abort signal fires.
 */
export function abortableSleep(
  ms: number,
  signal: AbortSignal,
  createAbortError: () => Error,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    let timer: TimeoutHandle | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearScheduledTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    timer = scheduleTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
