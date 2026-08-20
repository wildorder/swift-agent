// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RefusalNotice, RefusalList } from '../components/RefusalNotice';
import { EventPanel } from '../components/EventPanel';
import { RefusalReasonSchema } from '../../../backend/src/mediator/protocol';
import type { RefusalFrame, RefusalReason } from '../../../backend/src/mediator/protocol';
import type { LoggedEvent } from '../session';

afterEach(() => {
  cleanup();
});

function frame(reason: RefusalReason, extras?: Partial<RefusalFrame>): RefusalFrame {
  return {
    type: 'refusal',
    reason,
    message: `mediator says: ${reason}`,
    ...extras,
  };
}

// ── Spec test 15 — each RefusalReason renders a distinct notice ─────

describe('RefusalNotice', () => {
  it('renders every RefusalReason as a distinct human-readable notice', () => {
    const reasons = RefusalReasonSchema.options;
    expect(reasons).toHaveLength(7);

    const headlines = new Set<string>();
    for (const reason of reasons) {
      const { unmount } = render(<RefusalNotice refusal={frame(reason)} />);
      const notice = screen.getByTestId(`refusal-${reason}`);
      expect(notice.getAttribute('data-reason')).toBe(reason);
      // The mediator's own message is rendered…
      expect(notice.textContent).toContain(`mediator says: ${reason}`);
      // …under a reason-specific headline (distinct across all reasons).
      const headline = notice.querySelector('strong')?.textContent ?? '';
      expect(headline.length).toBeGreaterThan(0);
      headlines.add(headline);
      unmount();
    }
    expect(headlines.size).toBe(reasons.length);
  });

  it('renders retryAfterSeconds and remaining details when present', () => {
    render(
      <RefusalNotice
        refusal={frame('rate_limit_session', {
          retryAfterSeconds: 42,
          remaining: { messages: 3, tokens: 100 },
        })}
      />,
    );
    const notice = screen.getByTestId('refusal-rate_limit_session');
    expect(notice.textContent).toContain('42');
    expect(notice.textContent).toContain('Messages remaining: 3');
    expect(notice.textContent).toContain('Tokens remaining: 100');
  });

  it('RefusalList renders nothing when there are no refusals', () => {
    const { container } = render(<RefusalList refusals={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

// ── Relayed ChatEvents still reach the WS-48 feed untouched ─────────

describe('feed integrity beside refusals', () => {
  it('the EventPanel still renders relayed ChatEvents while refusals render separately (beats unbroken)', () => {
    const events: LoggedEvent[] = [
      {
        seq: 0,
        at: 1_000,
        event: {
          type: 'tool_call_started',
          callId: 'tc_demo_1',
          runId: 'run_1',
          sessionId: 'ses_demo',
          toolName: 'get_weather',
        },
      },
    ];

    render(
      <>
        <RefusalList refusals={[frame('daily_ceiling')]} />
        <EventPanel events={events} />
      </>,
    );

    // The refusal shows…
    expect(screen.getByTestId('refusal-daily_ceiling')).toBeTruthy();
    // …and the raw ChatEvent feed still carries the untouched event.
    fireEvent.click(screen.getByRole('button', { name: 'Raw events' }));
    const raw = screen.getByTestId('raw-events');
    expect(raw.textContent).toContain('"type": "tool_call_started"');
    expect(raw.textContent).toContain('"callId": "tc_demo_1"');
    // The refusal never leaks into the ChatEvent feed.
    expect(raw.textContent).not.toContain('refusal');
  });
});
