import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAgentChat } from '@swiftagent/react';

/** The session payload minted by the backend's `/api/session` route. */
interface Session {
  sessionId: string;
  token: string;
  websocketUrl: string;
}

export function App() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session')
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/session failed: ${res.status}`);
        return res.json() as Promise<Session>;
      })
      .then((data) => {
        if (!cancelled) setSession(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p style={{ color: 'crimson' }}>Failed to start session: {error}</p>;
  }
  if (!session) {
    return <p>Starting session…</p>;
  }

  // Render the chat only once we have session data so the hook — which must run
  // unconditionally — lives in a child that always has its inputs.
  return <Chat session={session} />;
}

function Chat({ session }: { session: Session }) {
  const [draft, setDraft] = useState('');

  // Thread the API-provided `websocketUrl` verbatim — never construct a
  // gateway URL here.
  const { messages, send, isStreaming, connectionStatus, lastError } = useAgentChat({
    sessionId: session.sessionId,
    token: session.token,
    websocketUrl: session.websocketUrl,
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>__PROJECT_NAME__</h1>
      <p>
        Status: <strong>{connectionStatus}</strong>
        {isStreaming ? ' · streaming…' : ''}
      </p>
      {lastError ? <p style={{ color: 'crimson' }}>Error: {lastError}</p> : null}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {messages.map((message) => (
          <li key={message.id} style={{ margin: '0.5rem 0' }}>
            <strong>{message.role}: </strong>
            <span>{message.content}</span>
          </li>
        ))}
      </ul>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          value={draft}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          placeholder='Say hello — the local fixture model calls the local_echo tool'
          style={{ flex: 1 }}
        />
        <button type='submit' disabled={connectionStatus !== 'connected'}>
          Send
        </button>
      </form>
    </main>
  );
}
