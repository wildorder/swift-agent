import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  createPlaygroundController,
  deriveToolCalls,
  fetchSessionInfo,
} from './session';
import type { PlaygroundController, SessionInfo } from './session';
import { EventPanel } from './components/EventPanel';
import { ToolCallCard } from './components/ToolCallCard';
import { ConnectionControls } from './components/ConnectionControls';
import { SourcePanel } from './components/SourcePanel';
import { FailureButton } from './components/FailureButton';
import { BoundaryNote } from './components/BoundaryNote';

interface DemoConfig {
  budgets: { toolName: string; budgetMs: number }[];
  agentSource: string;
  reproduceCommand: string;
}

export function App() {
  const [session, setSession] = useState<SessionInfo | undefined>(undefined);
  const [demoConfig, setDemoConfig] = useState<DemoConfig | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessionInfo()
      .then((info) => {
        if (!cancelled) setSession(info);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    fetch('/api/demo-config')
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/demo-config failed: ${res.status}`);
        return res.json() as Promise<DemoConfig>;
      })
      .then((config) => {
        if (!cancelled) setDemoConfig(config);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p style={{ color: 'crimson' }}>Failed to start the playground: {error}</p>;
  }
  if (!session || !demoConfig) {
    return <p>Starting session…</p>;
  }
  return <Playground session={session} demoConfig={demoConfig} />;
}

function Playground({
  session,
  demoConfig,
}: {
  session: SessionInfo;
  demoConfig: DemoConfig;
}) {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const [draft, setDraft] = useState('');

  const controllerRef = useRef<PlaygroundController | null>(null);
  controllerRef.current ??= createPlaygroundController(session, {
    onChange: forceUpdate,
  });
  const controller = controllerRef.current;

  const toolCalls = deriveToolCalls(controller.events);
  const budgetByTool = useMemo(
    () => new Map(demoConfig.budgets.map((b) => [b.toolName, b.budgetMs])),
    [demoConfig],
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    controller.send(text);
    setDraft('');
  };

  return (
    <main style={{ maxWidth: 960, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Swift Agent Playground</h1>
      <p style={{ maxWidth: '48rem' }}>
        This page renders the raw typed event stream a Swift Agent session
        produces — infrastructure, not a chat widget.
      </p>
      <BoundaryNote />

      <h2>Event stream</h2>
      <EventPanel events={controller.events} />

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0' }}>
        <input
          value={draft}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          placeholder="Try: what's the weather in Lisbon? or: calculate 12 * (3 + 4)"
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={controller.status !== 'connected'}>
          Send
        </button>
      </form>

      <FailureButton onSend={(text) => controller.send(text)} />

      <h2>Tool calls</h2>
      {toolCalls.length === 0 ? (
        <p>No tool calls yet — ask about the weather or some arithmetic.</p>
      ) : (
        toolCalls.map((call) => (
          <ToolCallCard
            key={call.callId}
            call={call}
            budgetMs={budgetByTool.get(call.toolName)}
          />
        ))
      )}

      <h2>Connection</h2>
      <ConnectionControls
        status={controller.status}
        onDrop={() => controller.drop()}
        onRecover={() => controller.recover()}
      />

      <SourcePanel
        agentSource={demoConfig.agentSource}
        reproduceCommand={demoConfig.reproduceCommand}
      />
    </main>
  );
}
