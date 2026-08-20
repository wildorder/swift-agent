import type { RefusalFrame, RefusalReason } from '../../../backend/src/mediator/protocol';

/**
 * WS-49 — renders each mediator refusal as a typed, human-readable notice
 * (SC-09: "typed, rendered"). One distinct headline per RefusalReason, plus
 * the mediator's own message and any retry/remaining detail. Presentation
 * only — the enforcement all happened server-side before this frame arrived.
 */

const HEADLINES: Record<RefusalReason, string> = {
  rate_limit_ip: 'Too many sessions from your address',
  rate_limit_session: 'Slow down a moment',
  message_cap: 'Message limit reached',
  token_cap: 'Token limit reached',
  daily_ceiling: 'Daily demo budget exhausted',
  session_expired: 'Guest session expired',
  bad_frame: 'That frame was not understood',
};

export function RefusalNotice({ refusal }: { refusal: RefusalFrame }) {
  return (
    <div
      role="status"
      data-testid={`refusal-${refusal.reason}`}
      data-reason={refusal.reason}
      style={{
        border: '1px solid #d97706',
        background: '#fffbeb',
        borderRadius: 6,
        padding: '0.5rem 0.75rem',
        margin: '0.5rem 0',
      }}
    >
      <strong>{HEADLINES[refusal.reason]}</strong>
      <p style={{ margin: '0.25rem 0 0' }}>{refusal.message}</p>
      {refusal.retryAfterSeconds !== undefined && (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em' }}>
          Try again in about {refusal.retryAfterSeconds}s.
        </p>
      )}
      {refusal.remaining?.messages !== undefined && (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em' }}>
          Messages remaining: {refusal.remaining.messages}
        </p>
      )}
      {refusal.remaining?.tokens !== undefined && (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em' }}>
          Tokens remaining: {refusal.remaining.tokens}
        </p>
      )}
    </div>
  );
}

export function RefusalList({ refusals }: { refusals: readonly RefusalFrame[] }) {
  if (refusals.length === 0) return null;
  return (
    <section aria-label="playground limits">
      {refusals.map((refusal, i) => (
        <RefusalNotice key={`${refusal.reason}-${i}`} refusal={refusal} />
      ))}
    </section>
  );
}
