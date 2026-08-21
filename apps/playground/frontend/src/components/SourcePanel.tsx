/**
 * Beat 4 — the conversion beat: the ~20 lines of defineAgent/tool composition
 * that produced this demo (served drift-guarded from the backend), plus the
 * one command that reproduces the whole stack locally.
 */
export function SourcePanel({
  agentSource,
  reproduceCommand,
}: {
  agentSource: string;
  reproduceCommand: string;
}) {
  return (
    <section aria-label="source panel">
      <h2>How this demo is built</h2>
      <p>
        This is the entire agent definition behind the page you are looking at —
        served verbatim from the running backend:
      </p>
      <pre
        data-testid="agent-source"
        style={{ overflowX: 'auto', background: '#f5f5f5', padding: '0.75rem' }}
      >
        {agentSource}
      </pre>
      <p>
        Reproduce the full stack locally from a clean checkout of the repo with
        one command:
      </p>
      <pre data-testid="reproduce-command" style={{ background: '#f5f5f5', padding: '0.75rem' }}>
        {reproduceCommand}
      </pre>
    </section>
  );
}
