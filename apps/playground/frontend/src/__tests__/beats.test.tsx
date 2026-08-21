// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EventPanel } from '../components/EventPanel';
import { ToolCallCard } from '../components/ToolCallCard';
import { ConnectionControls } from '../components/ConnectionControls';
import { BoundaryNote } from '../components/BoundaryNote';
import type { LoggedEvent, ToolCallView } from '../session';

afterEach(() => {
  cleanup();
});

const SAMPLE_EVENTS: LoggedEvent[] = [
  {
    seq: 0,
    at: 1_000,
    event: {
      type: 'message_started',
      messageId: 'msg_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
    },
  },
  {
    seq: 1,
    at: 1_010,
    event: {
      type: 'tool_call_started',
      callId: 'tc_demo_1',
      runId: 'run_1',
      sessionId: 'ses_demo',
      toolName: 'get_weather',
    },
  },
  {
    seq: 2,
    at: 1_200,
    event: {
      type: 'run_failed',
      runId: 'run_1',
      sessionId: 'ses_demo',
      code: 'PROVIDER_ERROR',
      message: 'demo failure',
    },
  },
];

// ── Spec test 11 — event panel toggle (Beat 1) ──────────────────────

describe('EventPanel', () => {
  it('renders the actual event JSON in the raw view and toggles without losing the log', () => {
    const { container } = render(<EventPanel events={SAMPLE_EVENTS} />);

    // Starts in pretty view.
    expect(screen.getByTestId('pretty-chat')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Raw events' }));
    const raw = screen.getByTestId('raw-events');
    // The raw view is JSON.stringify of the ACTUAL event objects.
    expect(raw.textContent).toContain('"type": "tool_call_started"');
    expect(raw.textContent).toContain('"callId": "tc_demo_1"');
    // run_failed frames render too.
    expect(raw.textContent).toContain('"type": "run_failed"');
    expect(raw.querySelectorAll('li')).toHaveLength(3);

    // Toggle back and forth — the log is not lost.
    fireEvent.click(screen.getByRole('button', { name: 'Pretty chat' }));
    expect(screen.getByTestId('pretty-chat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Raw events' }));
    expect(screen.getByTestId('raw-events').querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).toContain('tc_demo_1');
  });
});

// ── Spec test 12 — ToolCallCard (Beat 2) ────────────────────────────

describe('ToolCallCard', () => {
  const completedCall: ToolCallView = {
    callId: 'tc_demo_1',
    toolName: 'get_weather',
    status: 'completed',
    startedAt: 1_010,
    completedAt: 1_233,
    durationMs: 223,
  };

  it('renders callId, the demo-owned budget label, and the measured duration', () => {
    render(<ToolCallCard call={completedCall} budgetMs={5_000} />);
    const card = screen.getByTestId('tool-call-tc_demo_1');

    expect(card.textContent).toContain('tc_demo_1');
    // The budget is labeled as demo-owned — not presented as a protocol field.
    expect(card.textContent).toContain('5000 ms');
    expect(card.textContent).toMatch(/demo-owned/i);
    expect(card.textContent).toMatch(/not a protocol field/i);
    expect(card.textContent).toContain('223 ms');
  });

  it('renders a distinct failed state for status "failed"', () => {
    render(
      <ToolCallCard
        call={{
          callId: 'tc_fail_1',
          toolName: 'unreliable_service',
          status: 'failed',
          startedAt: 2_000,
          completedAt: 3_500,
          durationMs: 1_500,
        }}
        budgetMs={1_500}
      />,
    );
    const card = screen.getByTestId('tool-call-tc_fail_1');
    expect(card.getAttribute('data-status')).toBe('failed');
    expect(card.textContent).toMatch(/failed/i);
  });
});

// ── Spec test 13 — honest copy present (Beat 3 + boundary) ──────────

describe('honest copy', () => {
  it('states that recovery constructs a new client against the same session, with no automatic-reconnect wording', () => {
    const { container } = render(
      <ConnectionControls status="connected" onDrop={() => {}} onRecover={() => {}} />,
    );
    const text = container.textContent ?? '';

    expect(text).toMatch(/disconnect\(\)/);
    expect(text).toMatch(/intentionally suppresses/i);
    expect(text).toMatch(/new client against the same\s+session/i);
    expect(text).toMatch(/the session — not\s+the socket — is the durable thing/i);
    expect(text).toMatch(/replays the active run/i);

    // No automatic-reconnect claim anywhere.
    expect(text).not.toMatch(/reconnects automatically/i);
    expect(text).not.toMatch(/automatic(ally)? reconnect/i);
    expect(text).not.toMatch(/auto-?reconnect/i);
  });

  it('carries the tools-run-on-our-infrastructure honesty line', () => {
    const { container } = render(<BoundaryNote />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/run on the demo(’|')s own\s+backend/i);
    expect(text).toMatch(/not on visitor infrastructure/i);
  });
});
