/**
 * WS-49 — in-memory sliding-window rate limiter.
 *
 * Deliberately process-local: the deployment is pinned to ONE instance
 * (SC-12), and a restart resetting these counters is acceptable because the
 * daily ceiling lives in the Postgres ledger, not here (see
 * docs/runbooks/realtime-operations.md §1 on process-local realtime state).
 */

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the oldest counted hit leaves the window (>= 1 when refused). */
  retryAfterSeconds: number;
}

export interface SlidingWindowLimiter {
  /** Record-and-check: counts the hit only when allowed. */
  check(key: string, nowMs: number): RateLimitVerdict;
  /** Drop tracking state for a key (e.g. guest eviction). */
  forget(key: string): void;
}

export function createSlidingWindowLimiter(opts: {
  max: number;
  windowMs: number;
}): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, nowMs: number): RateLimitVerdict {
      const windowStart = nowMs - opts.windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);

      if (timestamps.length >= opts.max) {
        hits.set(key, timestamps);
        const oldest = timestamps[0] ?? nowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + opts.windowMs - nowMs) / 1000));
        return { allowed: false, retryAfterSeconds };
      }

      timestamps.push(nowMs);
      hits.set(key, timestamps);
      return { allowed: true, retryAfterSeconds: 0 };
    },

    forget(key: string): void {
      hits.delete(key);
    },
  };
}
