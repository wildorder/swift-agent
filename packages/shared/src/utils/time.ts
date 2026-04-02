/**
 * Returns the current date. Extracted for testability — tests can mock this.
 */
export function now(): Date {
  return new Date();
}

/**
 * Converts a Date to an ISO 8601 string.
 */
export function toIso(date: Date): string {
  return date.toISOString();
}

/**
 * Clamps a TTL value between min and max seconds.
 */
export function clampTtl(ttl: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, ttl));
}
