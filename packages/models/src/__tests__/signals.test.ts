import { describe, it, expect } from 'vitest';
import { mergeSignals } from '../signals.js';

describe('mergeSignals', () => {
  it('returns a non-aborted signal when both args are undefined', () => {
    const signal = mergeSignals(undefined, undefined);
    expect(signal.aborted).toBe(false);
  });

  it('returns the user signal when no timeout is given', () => {
    const controller = new AbortController();
    const signal = mergeSignals(controller.signal, undefined);

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('user abort triggers combined signal', () => {
    const controller = new AbortController();
    const signal = mergeSignals(controller.signal, 60_000);

    expect(signal.aborted).toBe(false);
    controller.abort('user cancelled');
    expect(signal.aborted).toBe(true);
  });

  it('timeout triggers combined signal', async () => {
    const signal = mergeSignals(undefined, 10); // 10ms timeout

    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(signal.aborted).toBe(true);
  });

  it('ignores zero or negative timeout', () => {
    const signal = mergeSignals(undefined, 0);
    expect(signal.aborted).toBe(false);
  });
});
