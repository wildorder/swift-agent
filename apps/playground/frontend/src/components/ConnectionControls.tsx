import type { ConnectionStatus } from '@swiftagent/react';

/**
 * Beat 3 — the session survives a dropped connection. The copy below is the
 * honest description of what actually happens: no automatic-reconnect claim.
 */
export function ConnectionControls({
  status,
  onDrop,
  onRecover,
}: {
  status: ConnectionStatus;
  onDrop: () => void;
  onRecover: () => void;
}) {
  return (
    <section aria-label="connection controls">
      <p>
        Connection: <strong data-testid="connection-status">{status}</strong>
      </p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" onClick={onDrop}>
          Drop connection
        </button>
        <button type="button" onClick={onRecover}>
          Recover session
        </button>
      </div>
      <p style={{ maxWidth: '48rem' }}>
        What actually happens: <strong>Drop</strong> calls the client&apos;s{' '}
        <code>disconnect()</code>, which intentionally suppresses that
        client&apos;s reconnection — a disconnected client never reconnects.{' '}
        <strong>Recover</strong> constructs a new client against the same
        session id and appends its events to the same feed. The session — not
        the socket — is the durable thing. While the run is still active, the
        server replays the active run&apos;s buffered events to the new
        connection on the same instance.
      </p>
    </section>
  );
}
