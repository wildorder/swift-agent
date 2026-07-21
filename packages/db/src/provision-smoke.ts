import { createHash } from 'node:crypto';
import {
  generateWorkspaceId,
  generateAgentId,
  generateApiKeyId,
} from '@swiftagent/shared';
import { createDbClient } from './client.js';
import { createWorkspaceRepo } from './repositories/workspace-repo.js';
import { createAgentRepo } from './repositories/agent-repo.js';
import { createApiKeyRepo } from './repositories/api-key-repo.js';

/**
 * WS-35 · Deployed realtime smoke test provisioning.
 *
 * Idempotently ensures the cloud realtime smoke test can run against a fresh
 * environment. It provisions exactly what `test/smoke/realtime-smoke.ts`
 * assumes:
 *
 *   1. a workspace to own the smoke resources,
 *   2. an API key whose `key_hash = sha256(SMOKE_API_KEY)` so the smoke test's
 *      `Authorization: Bearer <SMOKE_API_KEY>` authenticates (auth hashes the
 *      presented key and looks it up — see packages/api middleware/auth.ts),
 *   3. a `smoke-echo` agent backed by the zero-cost `echo/echo` provider, which
 *      deterministically streams token frames (no model cost/nondeterminism).
 *
 * Runs on every deploy as a one-off task; every step is find-or-create so
 * repeated runs converge without duplicates. The raw key is NEVER logged — it
 * arrives via env and only its hash is persisted.
 *
 * Required env:
 *   DATABASE_URL     Postgres connection string (injected as an ECS secret).
 *   SMOKE_API_KEY    Raw smoke key; its sha256 becomes the stored key_hash.
 * Optional env:
 *   SMOKE_AGENT_NAME Agent name to provision (default: smoke-echo). Must match
 *                    the smoke test's SMOKE_AGENT_NAME.
 *   SMOKE_WORKSPACE_NAME  Workspace name (default: Smoke Workspace).
 */

const AGENT_NAME = process.env['SMOKE_AGENT_NAME'] ?? 'smoke-echo';
const WORKSPACE_NAME = process.env['SMOKE_WORKSPACE_NAME'] ?? 'Smoke Workspace';
/** The echo provider (apps/server registers `echo`); no API key, no cost. */
const ECHO_MODEL = 'echo/echo';

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

async function provision(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const rawKey = process.env['SMOKE_API_KEY'];
  if (!rawKey) {
    throw new Error('SMOKE_API_KEY environment variable is required');
  }
  const keyHash = hashApiKey(rawKey);

  const { db, close } = createDbClient(connectionString);
  const workspaceRepo = createWorkspaceRepo(db);
  const agentRepo = createAgentRepo(db);
  const apiKeyRepo = createApiKeyRepo(db);

  try {
    console.log('Provisioning realtime smoke resources...');

    // 1. API key first: if it already exists we adopt ITS workspace, so the key
    //    and the agent always live together (session creation resolves the agent
    //    by name within the key's workspace).
    const existingKey = await apiKeyRepo.getByKeyHash(keyHash);

    let workspaceId: string;
    if (existingKey) {
      workspaceId = existingKey.workspaceId;
      console.log(`  API key present (${existingKey.apiKeyId}) in workspace ${workspaceId}`);
    } else {
      // 2. Find-or-create the smoke workspace.
      const existingWs = await workspaceRepo.getByName(WORKSPACE_NAME);
      const workspace =
        existingWs ??
        (await workspaceRepo.create({ workspaceId: generateWorkspaceId(), name: WORKSPACE_NAME }));
      workspaceId = workspace.workspaceId;
      console.log(`  Workspace ${existingWs ? 'reused' : 'created'}: ${workspaceId}`);

      const apiKey = await apiKeyRepo.create({
        apiKeyId: generateApiKeyId(),
        workspaceId,
        keyHash,
        name: 'Realtime Smoke Key',
      });
      console.log(`  API key created: ${apiKey.apiKeyId} (hash of SMOKE_API_KEY)`);
    }

    // 3. Find-or-create the echo-backed smoke agent in that workspace.
    const existingAgent = await agentRepo.getByName(workspaceId, AGENT_NAME);
    if (existingAgent) {
      console.log(`  Agent reused: ${existingAgent.agentId} (${AGENT_NAME})`);
    } else {
      const agent = await agentRepo.create({
        agentId: generateAgentId(),
        workspaceId,
        name: AGENT_NAME,
        modelConfig: { model: ECHO_MODEL },
        systemPrompt: 'Deterministic echo agent for the deployed realtime smoke test.',
        memoryConfig: { strategy: 'last_n', maxMessages: 50 },
      });
      console.log(`  Agent created: ${agent.agentId} (${AGENT_NAME} → ${ECHO_MODEL})`);
    }

    console.log('Smoke provisioning complete.');
  } finally {
    await close();
  }
}

provision().catch((err) => {
  console.error('Smoke provisioning failed:', err);
  process.exit(1);
});
