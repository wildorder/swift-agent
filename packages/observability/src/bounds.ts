import type { SpanRecord, SpanError } from './types.js';

/**
 * Hard limits applied to a `SpanRecord` before it leaves the observability
 * layer, so a pathological tool error or a huge metadata blob cannot bloat
 * `trace_spans`. Exported so tests assert against the source of truth (not
 * magic numbers) and future callers can reference them.
 */
export const MAX_SPAN_ERROR_MESSAGE_CHARS = 2048;
export const MAX_SPAN_METADATA_BYTES = 8192;

/**
 * Keys whose values are always preserved verbatim ahead of the metadata budget
 * walk. These are small and load-bearing: the token counts drive
 * `deriveRunMetrics`, and the name/id keys correlate spans — bounding must never
 * zero them out.
 */
const METADATA_WHITELIST: readonly string[] = [
  'promptTokens',
  'completionTokens',
  'modelName',
  'toolName',
  'callId',
];

const TRUNCATED_VALUE = '[truncated]';
const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Returns a NEW, bounded copy of `record` — never mutates the input record or
 * its `metadata`/`error`. Pure and dependency-free.
 *
 * - `error.message` is capped at {@link MAX_SPAN_ERROR_MESSAGE_CHARS}, appending
 *   a `…[truncated]` suffix when it exceeded; `error.code` is preserved verbatim.
 * - `metadata` is capped at a total serialized budget of
 *   {@link MAX_SPAN_METADATA_BYTES}. Whitelisted keys are kept first; remaining
 *   keys are walked in insertion order, and the first value that would exceed
 *   the budget (and every subsequent value) is replaced by `'[truncated]'` with
 *   a `__truncated: true` marker so the truncation is observable.
 */
export function boundSpanRecord(record: SpanRecord): SpanRecord {
  const bounded: SpanRecord = {
    ...record,
    metadata: boundMetadata(record.metadata),
  };
  if (record.error) {
    bounded.error = boundError(record.error);
  }
  return bounded;
}

function boundError(error: SpanError): SpanError {
  if (error.message.length <= MAX_SPAN_ERROR_MESSAGE_CHARS) {
    return { ...error };
  }
  const bounded: SpanError = {
    message: error.message.slice(0, MAX_SPAN_ERROR_MESSAGE_CHARS) + TRUNCATION_SUFFIX,
  };
  // Never drop the code — it is small and load-bearing for classification.
  if (error.code !== undefined) {
    bounded.code = error.code;
  }
  return bounded;
}

function boundMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Whitelisted keys first, verbatim — bounding can never truncate these.
  for (const key of METADATA_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      result[key] = metadata[key];
    }
  }

  let runningBytes = 0;
  let truncating = false;
  for (const key of Object.keys(metadata)) {
    if (METADATA_WHITELIST.includes(key)) continue;

    if (truncating) {
      result[key] = TRUNCATED_VALUE;
      continue;
    }

    const serialized = JSON.stringify(metadata[key]) ?? '';
    const valueBytes = Buffer.byteLength(serialized, 'utf8');
    if (runningBytes + valueBytes > MAX_SPAN_METADATA_BYTES) {
      truncating = true;
      result[key] = TRUNCATED_VALUE;
    } else {
      runningBytes += valueBytes;
      result[key] = metadata[key];
    }
  }

  if (truncating) {
    result.__truncated = true;
  }
  return result;
}
