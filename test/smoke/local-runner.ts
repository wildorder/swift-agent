import { readFileSync } from 'node:fs';
import { importJWK, importSPKI } from 'jose';
import { z } from 'zod';
import { tool } from '@swiftagent/sdk';
import type { ToolDefinition } from '@swiftagent/sdk';
// The runner-hosting surface lives behind the declared (unstable) internal
// subpath — the same server the SDK's `app.listen()` starts.
import { startToolRunner } from '@swiftagent/sdk/internal';

/**
 * WS-43 · Local compose tool-runner service (SC-01).
 *
 * The entry point for the compose `runner` service: hosts the real SDK tool
 * runner (`startToolRunner` — versioned POST /tools/:toolName with scoped-token
 * verification, unauthenticated GET /health) with exactly one deterministic
 * `local_echo` tool, so the bootstrap-provisioned `local-dev` agent can
 * complete a real tool round trip with zero external dependencies.
 *
 * Identity wiring:
 *   - RUNNER_TOKEN_PUBLIC_KEY (env, PEM SPKI or JWK JSON) — the dev-only public
 *     verification key committed in docker-compose.yml.
 *   - workspaceId — read from /bootstrap-out/runner-env.json, written by the
 *     bootstrap service (this service starts only after bootstrap completes).
 *   - RUNNER_AUDIENCE (env, default http://runner:8090) — MUST equal the
 *     agent's toolRunnerUrl: the server mints tokens with `aud` bound to that
 *     URL (apps/server/src/container.ts).
 */

const PORT = 8090;
const RUNNER_ENV_FILE = process.env.RUNNER_ENV_FILE ?? '/bootstrap-out/runner-env.json';
const DEFAULT_AUDIENCE = 'http://runner:8090';

/** Accepted signing algorithm — must match the runtime minter (EdDSA / Ed25519). */
const RUNNER_TOKEN_ALG = 'EdDSA';

/** Import the verification key from PEM (SPKI) or JWK JSON material. */
async function importPublicKey(material: string): Promise<Awaited<ReturnType<typeof importSPKI>>> {
  const trimmed = material.trim();
  if (trimmed.startsWith('{')) {
    return (await importJWK(JSON.parse(trimmed), RUNNER_TOKEN_ALG)) as Awaited<
      ReturnType<typeof importSPKI>
    >;
  }
  return importSPKI(trimmed, RUNNER_TOKEN_ALG);
}

const localEchoTool = tool({
  name: 'local_echo',
  description: 'Echo a message back, optionally shouting it (local dev tool).',
  inputSchema: z.object({
    message: z.string().min(1),
    shout: z.boolean().optional(),
  }),
  execute: async ({ message, shout }) => {
    return { echoed: shout ? message.toUpperCase() : message };
  },
});

async function main(): Promise<void> {
  const publicKeyMaterial = process.env.RUNNER_TOKEN_PUBLIC_KEY;
  if (!publicKeyMaterial) {
    throw new Error('RUNNER_TOKEN_PUBLIC_KEY environment variable is required');
  }

  const runnerEnv = JSON.parse(readFileSync(RUNNER_ENV_FILE, 'utf-8')) as {
    workspaceId?: string;
  };
  if (!runnerEnv.workspaceId) {
    throw new Error(`${RUNNER_ENV_FILE} is missing workspaceId — did the bootstrap service run?`);
  }

  const publicKey = await importPublicKey(publicKeyMaterial);
  const audience = process.env.RUNNER_AUDIENCE ?? DEFAULT_AUDIENCE;

  const registry = new Map<string, ToolDefinition>([[localEchoTool.name, localEchoTool]]);

  await startToolRunner({
    port: PORT,
    registry,
    auth: {
      publicKey,
      expectedAudience: audience,
      expectedWorkspaceId: runnerEnv.workspaceId,
    },
  });

  console.log(
    `local runner ready on :${PORT} (audience=${audience}, workspace=${runnerEnv.workspaceId}, tools=[local_echo])`,
  );
}

main().catch((err) => {
  console.error('local runner failed to start:', err);
  process.exit(1);
});
