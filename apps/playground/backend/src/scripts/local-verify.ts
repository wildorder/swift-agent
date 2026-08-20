import { readFileSync } from 'node:fs';
import { ControlPlaneClient } from '@swiftagent/sdk/internal';
import { createDbClient, createPlaygroundSpendRepo } from '@swiftagent/db';
import { buildServer, loadDemoConfig } from '../server.js';
import { loadMediatorConfig } from '../mediator/config.js';

/**
 * WS-49 — local verification entry (spec step 5): boots ONLY the guarded
 * mediator (no AgentApp/tool-runner) against the WS-43 compose stack, so the
 * full mediator topology — credential-free mint, proxied stream, verbatim
 * relay, every limit, and the REAL Postgres ledger — can be driven end-to-end
 * with `pnpm smoke:playground` and a raw WS client, at zero model cost (the
 * stack's `local-dev` agent runs the deterministic tool-calling fixture).
 *
 *   docker compose up -d            # WS-43 stack (server on :3000)
 *   pnpm --filter @swiftagent/db migrate   # apply the ledger migration
 *   pnpm --filter @swiftagent/playground exec tsx backend/src/scripts/local-verify.ts
 *   PLAYGROUND_SMOKE_URL=http://127.0.0.1:4100 pnpm smoke:playground
 *
 * Env (all defaulted to the compose stack):
 *   SWIFT_AGENT_API_KEY / SWIFT_AGENT_API_KEY_FILE (default ./.swiftagent-local/dev-api-key)
 *   SWIFT_AGENT_BASE_URL   (default http://localhost:3000)
 *   DATABASE_URL           (default the compose Postgres on localhost:5432)
 *   PLAYGROUND_AGENT_NAME  (default local-dev — the fixture-backed agent)
 *   PORT                   (default 4100) — plus every PLAYGROUND_* guardrail env
 */

function resolveApiKey(): string {
  const direct = process.env.SWIFT_AGENT_API_KEY;
  if (direct) return direct;
  const file = process.env.SWIFT_AGENT_API_KEY_FILE ?? './.swiftagent-local/dev-api-key';
  return readFileSync(file, 'utf8').trim();
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();
  const baseUrl = process.env.SWIFT_AGENT_BASE_URL ?? 'http://localhost:3000';
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://swiftagent:swiftagent_dev@localhost:5432/swiftagent';
  const agentName = process.env.PLAYGROUND_AGENT_NAME ?? 'local-dev';

  const dbClient = createDbClient(databaseUrl);
  const server = await buildServer({
    mediator: {
      control: new ControlPlaneClient(apiKey, baseUrl),
      ledger: createPlaygroundSpendRepo(dbClient.db),
      config: loadMediatorConfig(),
      agentName,
    },
    demoConfig: loadDemoConfig(),
    logger: true,
  });
  server.addHook('onClose', async () => {
    await dbClient.close();
  });

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4100;
  await server.listen({ port, host: '127.0.0.1' });
  console.log(
    `[playground-local-verify] Mediator on http://127.0.0.1:${port} → runtime ${baseUrl} (agent: ${agentName}); ledger in ${databaseUrl.replace(/\/\/.*@/, '//…@')}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
