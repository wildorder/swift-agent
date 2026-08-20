import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createAgentApp } from '@swiftagent/sdk';
import { ENV_KEYS } from '@swiftagent/shared';
import { playgroundAgent } from './agent.js';
import { listDemoBudgets } from './tools/budget.js';
import type { DemoBudget } from './tools/budget.js';

/**
 * The one command that reproduces this demo's stack locally, quoted exactly
 * from the repo README's "Run locally" section (WS-43): a self-provisioned
 * end-to-end stack from a clean checkout.
 */
export const REPRODUCE_COMMAND = 'docker compose up';

export interface DemoConfig {
  /** Demo-owned tool budgets (from this demo's withBudget wrapper — NOT a protocol field). */
  budgets: DemoBudget[];
  /** The verbatim source of backend/src/agent.ts — the Beat 4 exhibit. */
  agentSource: string;
  /** The reproduce-locally command per WS-43's documented path. */
  reproduceCommand: string;
}

/**
 * Read the agent exhibit's source from disk. Resolved relative to this module:
 * running from source (tsx/vitest) finds `agent.ts` alongside; running from the
 * compiled `dist/backend` output falls back to the package's `backend/src`.
 */
export function loadAgentSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'agent.ts'),
    join(here, '..', '..', 'backend', 'src', 'agent.ts'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `Could not locate agent.ts for the source exhibit (looked in: ${candidates.join(', ')})`,
  );
}

export function loadDemoConfig(): DemoConfig {
  return {
    budgets: listDemoBudgets(),
    agentSource: loadAgentSource(),
    reproduceCommand: REPRODUCE_COMMAND,
  };
}

/** The minimal session-minting surface the HTTP server needs (mockable in tests). */
export interface SessionMinter {
  create(opts: { agentName: string; userId?: string }): Promise<{
    sessionId: string;
    clientToken: string;
    websocketUrl: string;
  }>;
}

/**
 * Build the demo's HTTP server (quickstart pattern). The browser gets ONLY
 * `{ sessionId, token, websocketUrl }` from `/api/session` — the workspace API
 * key never leaves this process — plus the demo-owned config from
 * `/api/demo-config`. Permissive CORS so the page works without the Vite proxy.
 */
export function buildServer(deps: {
  sessions: SessionMinter;
  demoConfig: DemoConfig;
  logger?: boolean;
}): FastifyInstance {
  const server = Fastify({ logger: deps.logger ?? false });

  server.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  });
  server.options('/api/session', async (_request, reply) => {
    reply.code(204).send();
  });
  server.options('/api/demo-config', async (_request, reply) => {
    reply.code(204).send();
  });

  // Guest session mint — no signup, no visitor-supplied key. The frontend gets
  // a short-lived client token + the canonical websocketUrl, nothing else.
  server.get('/api/session', async () => {
    const session = await deps.sessions.create({
      agentName: playgroundAgent.name,
      userId: 'playground-guest',
    });
    return {
      sessionId: session.sessionId,
      token: session.clientToken,
      websocketUrl: session.websocketUrl,
    };
  });

  // Everything the frontend beats need that is NOT on the event stream: the
  // demo-owned budgets (Beat 2), the agent source (Beat 4), and the
  // reproduce-locally command (Beat 4).
  server.get('/api/demo-config', async () => deps.demoConfig);

  return server;
}

/**
 * Wire up the AgentApp and the HTTP server. All environment reads happen here
 * (never at import time) so tests can import this module without booting.
 */
async function main(): Promise<void> {
  const app = createAgentApp({
    apiKey: process.env.SWIFT_AGENT_API_KEY ?? '',
    baseUrl: process.env.SWIFT_AGENT_BASE_URL,
  });

  app.agent(playgroundAgent);

  if (
    !process.env[ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY] ||
    !process.env[ENV_KEYS.RUNNER_WORKSPACE_ID]
  ) {
    console.warn(
      `[playground-backend] Set ${ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY} and ` +
        `${ENV_KEYS.RUNNER_WORKSPACE_ID} — app.listen() requires them.`,
    );
  }

  const server = buildServer({
    sessions: app.sessions,
    demoConfig: loadDemoConfig(),
    logger: true,
  });

  // Starts the tool runner (hosting the playground tools) and registers the
  // agent with the control plane.
  await app.listen();

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4100;
  await server.listen({ port, host: '0.0.0.0' });
  console.log(
    `[playground-backend] Listening on http://127.0.0.1:${port} (/api/session, /api/demo-config)`,
  );
}

// Only start when run directly (`tsx`/`node`), never on import — the unit
// tests import this module for buildServer/loadDemoConfig and must not boot.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
