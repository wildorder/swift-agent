import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { tool } from '@swiftagent/sdk';
import type { ToolContext } from '@swiftagent/sdk';
import { createGetWeatherTool } from '../tools/weather.js';
import { calculateTool, evaluateExpression } from '../tools/calculate.js';
import {
  unreliableServiceTool,
  UNRELIABLE_HANG_MS,
} from '../tools/unreliable-service.js';
import { withBudget, listDemoBudgets } from '../tools/budget.js';

const ctx: ToolContext = {
  sessionId: 'ses_test',
  agentId: 'agt_test',
  runId: 'run_test',
  callId: 'tc_test',
};

afterEach(() => {
  vi.useRealTimers();
});

// ── Useful tools execute (spec test 1) ──────────────────────────────

describe('get_weather', () => {
  it('geocodes then fetches the forecast via the injected fetch and returns typed conditions', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://geocoding-api.open-meteo.com/v1/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { name: 'Lisbon', latitude: 38.72, longitude: -9.14, country: 'Portugal' },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          current: { temperature_2m: 21.5, wind_speed_10m: 12.3, weather_code: 2 },
        }),
      };
    };

    const weather = createGetWeatherTool(fakeFetch);
    const result = await weather.execute({ city: 'Lisbon' }, ctx);

    expect(result).toEqual({
      city: 'Lisbon',
      country: 'Portugal',
      temperatureC: 21.5,
      windSpeedKmh: 12.3,
      weatherCode: 2,
    });
    // Both round trips hit the fixed Open-Meteo hosts only.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('https://geocoding-api.open-meteo.com/v1/search');
    expect(calls[0]).toContain('name=Lisbon');
    expect(calls[1]).toContain('https://api.open-meteo.com/v1/forecast');
  });

  it('throws a clear error when no location matches', async () => {
    const weather = createGetWeatherTool(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }));
    await expect(weather.execute({ city: 'Nowhereville' }, ctx)).rejects.toThrow(
      /No location found/,
    );
  });

  it('rejects invalid input via the Zod inputSchema', () => {
    const weather = createGetWeatherTool(async () => {
      throw new Error('must not be called');
    });
    expect(weather.inputSchema.safeParse({ city: '' }).success).toBe(false);
    expect(weather.inputSchema.safeParse({}).success).toBe(false);
    expect(weather.inputSchema.safeParse({ city: 'Paris' }).success).toBe(true);
  });
});

describe('calculate', () => {
  it('evaluates arithmetic with precedence, parentheses, and unary minus — no eval', async () => {
    const result = await calculateTool.execute({ expression: '2 + 3 * 4' }, ctx);
    expect(result).toEqual({ expression: '2 + 3 * 4', result: 14 });

    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('-5 + 2')).toBe(-3);
    expect(evaluateExpression('10 / 4')).toBe(2.5);
    expect(evaluateExpression('10 % 3')).toBe(1);
  });

  it('throws on malformed or non-arithmetic expressions instead of executing them', () => {
    expect(() => evaluateExpression('2 +')).toThrow();
    expect(() => evaluateExpression('process.exit(1)')).toThrow(/Unexpected character/);
    expect(() => evaluateExpression('1 / 0')).toThrow(/Division by zero/);
  });

  it('rejects invalid input via the Zod inputSchema', () => {
    expect(calculateTool.inputSchema.safeParse({ expression: '' }).success).toBe(false);
    expect(calculateTool.inputSchema.safeParse({}).success).toBe(false);
    expect(calculateTool.inputSchema.safeParse({ expression: '1+1' }).success).toBe(true);
  });
});

// ── Budget wrapper (spec tests 2 & 3) ───────────────────────────────

describe('withBudget', () => {
  it('passes through a tool that finishes inside its budget and registers the budget', async () => {
    const fast = tool({
      name: 'fast_demo_tool',
      description: 'Finishes immediately.',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });

    const wrapped = withBudget(fast, 250);
    await expect(wrapped.execute({}, ctx)).resolves.toEqual({ ok: true });
    expect(listDemoBudgets()).toContainEqual({
      toolName: 'fast_demo_tool',
      budgetMs: 250,
    });
  });

  it('rejects when the tool exceeds its budget (fake timers) — the runtime path yields status "failed"', async () => {
    vi.useFakeTimers();
    const slow = tool({
      name: 'slow_demo_tool',
      description: 'Never finishes inside the budget.',
      inputSchema: z.object({}),
      execute: async () =>
        new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10_000)),
    });

    const wrapped = withBudget(slow, 50);
    const pending = wrapped.execute({}, ctx);
    const assertion = expect(pending).rejects.toThrow(
      /exceeded its demo-owned budget of 50ms/,
    );
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it('unreliable_service deterministically breaches its budget', async () => {
    vi.useFakeTimers();
    const wrapped = withBudget(unreliableServiceTool, 1_500);
    const pending = wrapped.execute({}, ctx);
    const assertion = expect(pending).rejects.toThrow(/exceeded its demo-owned budget/);
    // The hang is far past the budget, so the wrapper's timer always wins.
    expect(UNRELIABLE_HANG_MS).toBeGreaterThan(1_500);
    await vi.advanceTimersByTimeAsync(1_501);
    await assertion;
  });
});
