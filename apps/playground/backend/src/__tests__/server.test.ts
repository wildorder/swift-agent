import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { playgroundAgent, playgroundTools } from '../agent.js';
import { buildServer, loadDemoConfig, REPRODUCE_COMMAND } from '../server.js';
import { loadMediatorConfig } from '../mediator/config.js';
import {
  RefusalFrameSchema,
  SessionReadyFrameSchema,
} from '../mediator/protocol.js';
import type { MediatorDeps, SpendLedger } from '../mediator/mediator.js';

// Importing server.ts only evaluates definitions — main() is guarded behind an
// entrypoint check, so no server boots and no env/network is needed.

const FAKE_API_KEY = 'ak_super_secret_workspace_key';
const FAKE_CLIENT_TOKEN = 'tok_client_jwt';
const FAKE_UPSTREAM_URL = 'ws://runtime.internal:3000/v1/stream?token=tok_client_jwt';

function noopLedger(): SpendLedger {
  return {
    reserve: async () => ({
      accepted: true,
      reservation: { reservationId: 'psr_test' },
      dayTotalMicroUsd: 0,
    }),
    attachRun: async () => null,
    settle: async () => null,
    sweepAbandoned: async () => [],
    dayTotal: async () => 0,
  };
}

function stubMediatorDeps(overrides?: Partial<MediatorDeps>): MediatorDeps {
  return {
    control: {
      createSession: async (body) => {
        expect(body.agentName).toBe('playground-assistant');
        return {
          sessionId: 'ses_demo',
          clientToken: FAKE_CLIENT_TOKEN,
          websocketUrl: FAKE_UPSTREAM_URL,
          // A field a careless implementation might leak:
          apiKey: FAKE_API_KEY,
        } as never;
      },
      getRun: async () => ({ status: 'completed', tokenUsage: null }),
      cancelRun: async () => ({}),
    },
    ledger: noopLedger(),
    config: loadMediatorConfig({}),
    agentName: playgroundAgent.name,
    ...overrides,
  };
}

describe('playgroundAgent (spec test 4 — agent shape)', () => {
  it('defines the playground-assistant with the full wrapped tool roster and a bounded maxTokens', () => {
    expect(playgroundAgent.name).toBe('playground-assistant');
    expect(playgroundAgent.modelConfig.model).toBe(
      process.env.PLAYGROUND_MODEL ?? 'anthropic/claude-3-5-haiku',
    );
    // WS-49: the per-round output bound anchoring the reservation formula.
    expect(playgroundAgent.modelConfig.maxTokens).toBe(1024);

    const toolNames = playgroundAgent.toolSchemas.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['get_weather', 'calculate', 'unreliable_service']),
    );
    expect(playgroundTools).toHaveLength(3);
    for (const t of playgroundTools) {
      expect(Object.isFrozen(t)).toBe(true);
    }
  });
});

describe('demo config (spec test 5 — Beat 4 drift guard)', () => {
  it('serves the agent source verbatim from disk, every wrapped budget, and a non-empty reproduce command', () => {
    const config = loadDemoConfig();

    const agentPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'agent.ts',
    );
    expect(config.agentSource).toBe(readFileSync(agentPath, 'utf8'));

    const budgetNames = config.budgets.map((b) => b.toolName);
    expect(budgetNames).toEqual(
      expect.arrayContaining(['get_weather', 'calculate', 'unreliable_service']),
    );
    for (const budget of config.budgets) {
      expect(budget.budgetMs).toBeGreaterThan(0);
    }

    expect(config.reproduceCommand).toBe(REPRODUCE_COMMAND);
    expect(config.reproduceCommand.length).toBeGreaterThan(0);
  });
});

describe('POST /playground/session (WS-49 — credential-free guest mint)', () => {
  it('returns the session_ready shape with guest id + limits and NO credential of any kind', async () => {
    const server = await buildServer({
      mediator: stubMediatorDeps(),
      demoConfig: loadDemoConfig(),
    });

    const response = await server.inject({ method: 'POST', url: '/playground/session' });
    expect(response.statusCode).toBe(200);

    const body = SessionReadyFrameSchema.parse(response.json());
    expect(body.guestId).toMatch(/^pg_/);
    expect(body.sessionId).toBe('ses_demo');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.limits.messagesPerSession).toBeGreaterThan(0);

    // The browser gets no workspace key, no client JWT, no upstream URL.
    expect(response.body).not.toContain(FAKE_API_KEY);
    expect(response.body).not.toContain(FAKE_CLIENT_TOKEN);
    expect(response.body).not.toContain('websocketUrl');
    expect(response.body).not.toContain('apiKey');
    expect(response.body).not.toContain('clientToken');

    await server.close();
  });

  it('refuses a mint burst past the per-IP limit with a 429 whose body is the typed refusal frame', async () => {
    const server = await buildServer({
      mediator: stubMediatorDeps({
        config: { ...loadMediatorConfig({}), ipLimit: { max: 2, windowMs: 60_000 } },
      }),
      demoConfig: loadDemoConfig(),
    });

    for (let i = 0; i < 2; i++) {
      const ok = await server.inject({ method: 'POST', url: '/playground/session' });
      expect(ok.statusCode).toBe(200);
    }
    const refused = await server.inject({ method: 'POST', url: '/playground/session' });
    expect(refused.statusCode).toBe(429);
    const frame = RefusalFrameSchema.parse(refused.json());
    expect(frame.reason).toBe('rate_limit_ip');
    expect(frame.retryAfterSeconds).toBeGreaterThan(0);

    await server.close();
  });

  it('serves /api/demo-config with the same payload loadDemoConfig produced (WS-48 route untouched)', async () => {
    const demoConfig = loadDemoConfig();
    const server = await buildServer({
      mediator: stubMediatorDeps(),
      demoConfig,
    });

    const response = await server.inject({ method: 'GET', url: '/api/demo-config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(demoConfig);

    await server.close();
  });

  it('exposes no legacy GET /api/session credential route', async () => {
    const server = await buildServer({
      mediator: stubMediatorDeps(),
      demoConfig: loadDemoConfig(),
    });
    const response = await server.inject({ method: 'GET', url: '/api/session' });
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});
