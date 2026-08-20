import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { playgroundAgent, playgroundTools } from '../agent.js';
import { buildServer, loadDemoConfig, REPRODUCE_COMMAND } from '../server.js';

// Importing server.ts only evaluates definitions — main() is guarded behind an
// entrypoint check, so no server boots and no env/network is needed.

describe('playgroundAgent (spec test 4 — agent shape)', () => {
  it('defines the playground-assistant with the full wrapped tool roster', () => {
    expect(playgroundAgent.name).toBe('playground-assistant');
    expect(playgroundAgent.modelConfig.model).toBe(
      process.env.PLAYGROUND_MODEL ?? 'anthropic/claude-3-5-haiku',
    );

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

describe('GET /api/session (spec test 6 — session route shape)', () => {
  it('returns exactly { sessionId, token, websocketUrl } and never the workspace API key', async () => {
    const fakeApiKey = 'ak_super_secret_workspace_key';
    const server = buildServer({
      sessions: {
        create: async (opts) => {
          expect(opts.agentName).toBe('playground-assistant');
          return {
            sessionId: 'ses_demo',
            clientToken: 'tok_client',
            websocketUrl: 'ws://localhost:3000/v1/stream?token=tok_client',
            // A field a careless implementation might leak:
            apiKey: fakeApiKey,
          } as never;
        },
      },
      demoConfig: loadDemoConfig(),
    });

    const response = await server.inject({ method: 'GET', url: '/api/session' });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['sessionId', 'token', 'websocketUrl']);
    expect(body).toEqual({
      sessionId: 'ses_demo',
      token: 'tok_client',
      websocketUrl: 'ws://localhost:3000/v1/stream?token=tok_client',
    });
    expect(response.body).not.toContain(fakeApiKey);
    expect(response.body).not.toContain('apiKey');

    await server.close();
  });

  it('serves /api/demo-config with the same payload loadDemoConfig produced', async () => {
    const demoConfig = loadDemoConfig();
    const server = buildServer({
      sessions: {
        create: async () => ({
          sessionId: 'ses_x',
          clientToken: 'tok_x',
          websocketUrl: 'ws://localhost:3000/v1/stream?token=tok_x',
        }),
      },
      demoConfig,
    });

    const response = await server.inject({ method: 'GET', url: '/api/demo-config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(demoConfig);

    await server.close();
  });
});
