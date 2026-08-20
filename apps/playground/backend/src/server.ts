import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { createAgentApp } from '@swiftagent/sdk';
import { ControlPlaneClient } from '@swiftagent/sdk/internal';
import { createDbClient, createPlaygroundSpendRepo } from '@swiftagent/db';
import { ENV_KEYS } from '@swiftagent/shared';
import { playgroundAgent } from './agent.js';
import { listDemoBudgets } from './tools/budget.js';
import type { DemoBudget } from './tools/budget.js';
import { loadMediatorConfig } from './mediator/config.js';
import { registerMediator } from './mediator/mediator.js';
import type { MediatorDeps } from './mediator/mediator.js';

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

/**
 * Build the demo's HTTP server, hardened into the WS-49 mediator topology:
 *
 * - `POST /playground/session` mints a guest session (per-IP rate limited);
 *   the browser receives an opaque guest id + the limits — NO credential of
 *   any kind (no workspace key, no client JWT, no upstream websocketUrl).
 * - `/playground/stream?gid=…` is the ONLY socket the browser holds; the
 *   mediator proxies to the runtime and enforces every limit (SC-09).
 * - `/api/demo-config` is WS-48's demo-owned config route, untouched.
 * - When `staticDir` is provided (the deployed single-instance container),
 *   the built frontend is served from the same process.
 */
export async function buildServer(deps: {
  mediator: MediatorDeps;
  demoConfig: DemoConfig;
  logger?: boolean;
  staticDir?: string;
  /** Honor X-Forwarded-For for per-IP limiting behind the host proxy. */
  trustProxy?: boolean;
}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
  });

  server.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  });
  server.options('/api/demo-config', async (_request, reply) => {
    reply.code(204).send();
  });

  // Everything the frontend beats need that is NOT on the event stream: the
  // demo-owned budgets (Beat 2), the agent source (Beat 4), and the
  // reproduce-locally command (Beat 4). WS-48's route, untouched.
  server.get('/api/demo-config', async () => deps.demoConfig);

  // SC-12: the serving instance's identity, polled by the observation
  // procedure (deploy/playground/README.md) to prove at most one instance
  // ever serves across a rolling deploy and a restart.
  server.get('/health', async () => ({
    status: 'ok',
    instance: process.env.FLY_MACHINE_ID ?? hostname(),
    uptimeSeconds: Math.round(process.uptime()),
  }));

  await registerMediator(server, deps.mediator);

  if (deps.staticDir) {
    await server.register(fastifyStatic, { root: deps.staticDir });
    // SPA fallback: any unknown GET path serves the app shell.
    server.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/playground')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return server;
}

/**
 * Wire up the AgentApp, the ledger, and the HTTP server. All environment reads
 * happen here (never at import time) so tests can import this module without
 * booting.
 */
async function main(): Promise<void> {
  const apiKey = process.env.SWIFT_AGENT_API_KEY ?? '';
  const baseUrl = process.env.SWIFT_AGENT_BASE_URL;

  const app = createAgentApp({ apiKey, baseUrl });
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

  // The playground's OWN isolated database — the Postgres-persisted daily
  // spend ledger (never in-memory; runbook §1 is exactly why).
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('[playground-backend] DATABASE_URL is required (the spend ledger is Postgres-persisted)');
  }
  const dbClient = createDbClient(databaseUrl);

  // The mediator composes the SDK's raw control-plane client for session
  // minting, run observation (getRun), and cap-breach cancellation.
  const control = new ControlPlaneClient(apiKey, baseUrl);

  const staticDirCandidate =
    process.env.PLAYGROUND_STATIC_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

  const server = await buildServer({
    mediator: {
      control,
      ledger: createPlaygroundSpendRepo(dbClient.db),
      config: loadMediatorConfig(),
      agentName: playgroundAgent.name,
    },
    demoConfig: loadDemoConfig(),
    logger: true,
    trustProxy: process.env.PLAYGROUND_TRUST_PROXY === '1',
    ...(existsSync(join(staticDirCandidate, 'index.html')) ? { staticDir: staticDirCandidate } : {}),
  });

  server.addHook('onClose', async () => {
    await dbClient.close();
  });

  // Starts the tool runner (hosting the playground tools) and registers the
  // agent with the control plane. The runner port is passed EXPLICITLY so the
  // host's PORT env (consumed by the HTTP server below) can never collide
  // with the runner's listener.
  const runnerPort = process.env.PLAYGROUND_TOOL_RUNNER_PORT
    ? Number.parseInt(process.env.PLAYGROUND_TOOL_RUNNER_PORT, 10)
    : 8090;
  await app.listen(runnerPort);

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4100;
  await server.listen({ port, host: '0.0.0.0' });
  console.log(
    `[playground-backend] Listening on http://127.0.0.1:${port} (POST /playground/session, WS /playground/stream, /api/demo-config)`,
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
