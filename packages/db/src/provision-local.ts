import { createHash, randomBytes } from 'node:crypto';
import { chownSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * WS-43 · Local compose stack bootstrap (SC-01).
 *
 * One-shot, idempotent provisioning for the `docker compose up` local stack —
 * a sibling of provision-smoke.ts (which the cloud deploy workflows invoke by
 * path and which stays untouched). Unlike the cloud path there is NO
 * pre-supplied secret anywhere: the dev API key is MINTED here, surfaced to
 * the developer, and never committed.
 *
 * It establishes, converging on re-runs without duplicates:
 *
 *   1. a workspace ('Local Dev Workspace'),
 *   2. a generated dev API key (`ak_local_` + random hex) whose sha256 hash is
 *      stored via the api-key repo (matching packages/api auth hashing). The
 *      RAW key is surfaced twice: printed once, clearly framed, in this
 *      service's log, and written to /bootstrap-out/dev-api-key (the compose
 *      bind mount of ./.swiftagent-local, which is gitignored). If that file
 *      already exists AND its hash matches a stored key, it is reused.
 *   3. a `local-dev` agent on the zero-cost `fixture/tool-call` model, carrying
 *      one `local_echo` tool (JSON-Schema wire form) and
 *      toolRunnerUrl http://runner:8090 (the compose `runner` service),
 *   4. /bootstrap-out/runner-env.json ({ workspaceId }) — the workspace-id
 *      handoff the runner service reads to verify scoped-token claims.
 *
 * Required env:
 *   DATABASE_URL   Postgres connection string (the compose postgres service).
 * Optional env:
 *   BOOTSTRAP_OUT  Output directory (default: /bootstrap-out).
 */

const WORKSPACE_NAME = 'Local Dev Workspace';
const AGENT_NAME = 'local-dev';
/** The flag-gated tool-calling fixture (apps/server registers `fixture`). */
const FIXTURE_MODEL = 'fixture/tool-call';
/** Must equal the runner service's verification audience (RUNNER_AUDIENCE). */
const TOOL_RUNNER_URL = 'http://runner:8090';

const OUT_DIR = process.env['BOOTSTRAP_OUT'] ?? '/bootstrap-out';
const KEY_FILE = join(OUT_DIR, 'dev-api-key');
const RUNNER_ENV_FILE = join(OUT_DIR, 'runner-env.json');

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** The persisted JSON-Schema wire form of the local_echo tool (see runtime-harness seededTool). */
const LOCAL_ECHO_TOOL = {
  name: 'local_echo',
  description: 'Echo a message back, optionally shouting it (local dev tool).',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      shout: { type: 'boolean' },
    },
    required: ['message'],
    additionalProperties: false,
  } as Record<string, unknown>,
};

function printKeyBanner(rawKey: string, reused: boolean): void {
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  LOCAL DEV API KEY ${reused ? '(reused)' : '(newly minted)'}`);
  console.log('');
  console.log(`  ${rawKey}`);
  console.log('');
  console.log('  Also written to ./.swiftagent-local/dev-api-key (gitignored).');
  console.log('  Use it as SWIFT_AGENT_API_KEY / Authorization: Bearer <key>');
  console.log('  against http://localhost:3000. LOCAL USE ONLY.');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * The compose bootstrap runs as root (on Linux the daemon creates the
 * ./.swiftagent-local bind mount root-owned, so the image's non-root user
 * cannot write it). Hand a written file back to the mount directory's owner
 * so the invoking host user can read it; when the directory is root-owned
 * (daemon-created), fall back to world-readable — this is a dev-only local
 * key in a gitignored directory. No-op on Windows / non-root runs.
 */
function handOffToMountOwner(path: string): void {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    const dir = statSync(OUT_DIR);
    if (dir.uid !== 0) {
      chownSync(path, dir.uid, dir.gid);
    } else {
      chmodSync(path, 0o644);
    }
  } catch {
    // Best effort — never fail provisioning over ownership cosmetics.
  }
}

async function provision(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const { db, close } = createDbClient(connectionString);
  const workspaceRepo = createWorkspaceRepo(db);
  const agentRepo = createAgentRepo(db);
  const apiKeyRepo = createApiKeyRepo(db);

  try {
    console.log('Provisioning local dev stack...');

    // 1. Dev API key — reuse the mounted key file when its hash matches a
    //    stored key (idempotent re-run over the same volume); otherwise mint.
    let rawKey: string | null = null;
    let workspaceId: string | null = null;
    let reusedKey = false;

    if (existsSync(KEY_FILE)) {
      const candidate = readFileSync(KEY_FILE, 'utf-8').trim();
      if (candidate) {
        const existing = await apiKeyRepo.getByKeyHash(hashApiKey(candidate));
        if (existing) {
          rawKey = candidate;
          workspaceId = existing.workspaceId;
          reusedKey = true;
          console.log(
            `  API key reused from ${KEY_FILE} (${existing.apiKeyId}) in workspace ${workspaceId}`,
          );
        } else {
          console.log('  Existing key file does not match a stored key — minting a fresh one.');
        }
      }
    }

    if (!rawKey || !workspaceId) {
      // 2. Find-or-create the local workspace, then mint + store the key in it.
      const existingWs = await workspaceRepo.getByName(WORKSPACE_NAME);
      const workspace =
        existingWs ??
        (await workspaceRepo.create({ workspaceId: generateWorkspaceId(), name: WORKSPACE_NAME }));
      workspaceId = workspace.workspaceId;
      console.log(`  Workspace ${existingWs ? 'reused' : 'created'}: ${workspaceId}`);

      rawKey = `ak_local_${randomBytes(24).toString('hex')}`;
      const apiKey = await apiKeyRepo.create({
        apiKeyId: generateApiKeyId(),
        workspaceId,
        keyHash: hashApiKey(rawKey),
        name: 'Local Dev Key',
      });
      console.log(`  API key created: ${apiKey.apiKeyId} (raw value below, never persisted raw)`);
    }

    // 3. Surface the raw key: file (mode-restricted) + clearly framed log line.
    writeFileSync(KEY_FILE, `${rawKey}\n`, { mode: 0o600 });
    handOffToMountOwner(KEY_FILE);
    printKeyBanner(rawKey, reusedKey);

    // 4. Find-or-create the fixture-backed local agent with the local_echo tool.
    const existingAgent = await agentRepo.getByName(workspaceId, AGENT_NAME);
    if (existingAgent) {
      console.log(`  Agent reused: ${existingAgent.agentId} (${AGENT_NAME})`);
    } else {
      const agent = await agentRepo.create({
        agentId: generateAgentId(),
        workspaceId,
        name: AGENT_NAME,
        modelConfig: { model: FIXTURE_MODEL },
        systemPrompt: 'Deterministic local dev agent backed by the tool-calling fixture provider.',
        memoryConfig: { strategy: 'last_n', maxMessages: 50 },
        tools: [LOCAL_ECHO_TOOL],
        toolRunnerUrl: TOOL_RUNNER_URL,
      });
      console.log(`  Agent created: ${agent.agentId} (${AGENT_NAME} → ${FIXTURE_MODEL}, tool runner ${TOOL_RUNNER_URL})`);
    }

    // 5. Workspace-id handoff for the runner service's token verification.
    writeFileSync(RUNNER_ENV_FILE, `${JSON.stringify({ workspaceId }, null, 2)}\n`, {
      mode: 0o644,
    });
    handOffToMountOwner(RUNNER_ENV_FILE);
    console.log(`  Runner env written: ${RUNNER_ENV_FILE} ({ workspaceId: ${workspaceId} })`);

    console.log('Local bootstrap complete.');
  } finally {
    await close();
  }
}

provision().catch((err) => {
  console.error('Local bootstrap failed:', err);
  process.exit(1);
});
