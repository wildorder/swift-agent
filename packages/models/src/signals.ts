/**
 * Combines a user-provided AbortSignal with an optional timeout into a
 * single signal using `AbortSignal.any()`.
 *
 * Used by provider implementations to enforce request timeouts while
 * still respecting caller cancellation.
 */
export function mergeSignals(
  userSignal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  const signals: AbortSignal[] = [];

  if (userSignal) {
    signals.push(userSignal);
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }

  if (signals.length === 0) {
    // Return a signal that never aborts
    return new AbortController().signal;
  }

  if (signals.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length checked above
    return signals[0]!;
  }

  return AbortSignal.any(signals);
}
