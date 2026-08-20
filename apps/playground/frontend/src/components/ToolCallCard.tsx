import type { ToolCallView } from '../session';

/**
 * Beat 2 — a tool call is a real round trip. The callId comes from the events,
 * the budget is DEMO-OWNED (from /api/demo-config, set by this demo's
 * withBudget wrapper — it is not a protocol field), and the duration is
 * measured from the real tool_call_started/tool_call_completed arrival pair
 * correlated by callId.
 */
export function ToolCallCard({
  call,
  budgetMs,
}: {
  call: ToolCallView;
  budgetMs?: number;
}) {
  const failed = call.status === 'failed';

  return (
    <article
      data-testid={`tool-call-${call.callId}`}
      data-status={call.status}
      style={{
        border: `2px solid ${failed ? 'crimson' : '#ccc'}`,
        background: failed ? '#fff0f0' : undefined,
        borderRadius: 6,
        padding: '0.5rem 0.75rem',
        margin: '0.5rem 0',
      }}
    >
      <h3 style={{ margin: '0 0 0.25rem', color: failed ? 'crimson' : undefined }}>
        {call.toolName}
        {failed ? ' — failed' : ''}
      </h3>
      <dl style={{ margin: 0 }}>
        <dt>callId</dt>
        <dd>
          <code>{call.callId}</code>
        </dd>
        <dt>Time budget</dt>
        <dd>
          {budgetMs !== undefined
            ? `${budgetMs} ms — demo-owned (set by this demo's withBudget wrapper, not a protocol field)`
            : 'not configured'}
        </dd>
        <dt>Measured duration</dt>
        <dd>
          {call.durationMs !== undefined
            ? `${call.durationMs} ms (tool_call_completed arrival − tool_call_started arrival)`
            : 'in flight…'}
        </dd>
        <dt>Status</dt>
        <dd>{call.status}</dd>
      </dl>
    </article>
  );
}
