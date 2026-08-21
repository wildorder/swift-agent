/**
 * The canned prompt engineered to make the model call `unreliable_service`.
 * With a real model this is a request, not a guarantee — the deterministic
 * proof of the failure path lives in the budget wrapper's unit tests.
 */
export const FAILURE_PROMPT =
  "Use the unreliable_service tool to check the demo backend's status.";

/** Beat 2's failure trigger — the demo shows the failure path on purpose. */
export function FailureButton({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div>
      <button type="button" onClick={() => onSend(FAILURE_PROMPT)}>
        Trigger a failing tool call
      </button>
      <p style={{ maxWidth: '48rem' }}>
        Sends a fixed prompt asking the agent to call a tool that will exceed
        its demo-owned time budget and fail — so you can watch{' '}
        <code>tool_call_completed</code> arrive with{' '}
        <code>status: &quot;failed&quot;</code> instead of the failure being
        hidden. With a real model this is a request, not a guarantee.
      </p>
    </div>
  );
}
