import { useState } from 'react';
import type { LoggedEvent } from '../session';

/**
 * Beat 1 — typed events, not text. The raw view pretty-prints the ACTUAL
 * received ChatEvent objects (JSON.stringify of the real feed, not a
 * reconstruction), toggleable against the prettified chat. `run_failed`
 * frames render too — they are part of the union and part of the honesty.
 */
export function EventPanel({ events }: { events: readonly LoggedEvent[] }) {
  const [view, setView] = useState<'pretty' | 'raw'>('pretty');

  return (
    <section aria-label="event panel">
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <button
          type="button"
          aria-pressed={view === 'pretty'}
          onClick={() => setView('pretty')}
        >
          Pretty chat
        </button>
        <button
          type="button"
          aria-pressed={view === 'raw'}
          onClick={() => setView('raw')}
        >
          Raw events
        </button>
      </div>

      {view === 'raw' ? (
        <ol data-testid="raw-events" style={{ listStyle: 'none', padding: 0 }}>
          {events.map((entry) => (
            <li key={entry.seq}>
              <pre style={{ overflowX: 'auto', margin: '0.25rem 0' }}>
                {JSON.stringify(entry.event, null, 2)}
              </pre>
            </li>
          ))}
        </ol>
      ) : (
        <PrettyChat events={events} />
      )}
    </section>
  );
}

function PrettyChat({ events }: { events: readonly LoggedEvent[] }) {
  type Row = { key: string; label: string; text: string; tone?: 'error' };
  const rows: Row[] = [];
  const messageRow = new Map<string, Row>();

  for (const { seq, event } of events) {
    switch (event.type) {
      case 'message_started': {
        const row: Row = { key: `msg-${event.messageId}`, label: 'assistant', text: '' };
        messageRow.set(event.messageId, row);
        rows.push(row);
        break;
      }
      case 'token': {
        const row = messageRow.get(event.messageId);
        if (row) {
          row.text += event.text;
        } else {
          const created: Row = {
            key: `msg-${event.messageId}`,
            label: 'assistant',
            text: event.text,
          };
          messageRow.set(event.messageId, created);
          rows.push(created);
        }
        break;
      }
      case 'tool_call_started':
        rows.push({
          key: `tcs-${seq}`,
          label: 'tool',
          text: `${event.toolName} started (${event.callId})`,
        });
        break;
      case 'tool_call_completed':
        rows.push({
          key: `tcc-${seq}`,
          label: 'tool',
          text: `${event.toolName} ${event.status} (${event.callId})`,
          ...(event.status === 'failed' ? { tone: 'error' as const } : {}),
        });
        break;
      case 'message_completed':
        break;
      case 'run_failed':
        rows.push({
          key: `rf-${seq}`,
          label: 'run failed',
          text: `${event.code}: ${event.message}`,
          tone: 'error',
        });
        break;
    }
  }

  if (rows.length === 0) {
    return <p>No events yet — send a message below.</p>;
  }

  return (
    <ul data-testid="pretty-chat" style={{ listStyle: 'none', padding: 0 }}>
      {rows.map((row) => (
        <li
          key={row.key}
          style={{ margin: '0.25rem 0', color: row.tone === 'error' ? 'crimson' : undefined }}
        >
          <strong>{row.label}: </strong>
          <span>{row.text}</span>
        </li>
      ))}
    </ul>
  );
}
