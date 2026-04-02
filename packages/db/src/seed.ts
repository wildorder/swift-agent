import {
  generateWorkspaceId,
  generateAgentId,
  generateSessionId,
  generateApiKeyId,
} from '@swiftagent/shared';
import { createDbClient } from './client.js';
import { createWorkspaceRepo } from './repositories/workspace-repo.js';
import { createAgentRepo } from './repositories/agent-repo.js';
import { createSessionRepo } from './repositories/session-repo.js';
import { createApiKeyRepo } from './repositories/api-key-repo.js';

async function seed() {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  if (process.env['SEED_ENABLED'] !== 'true') {
    console.log('Seed skipped: set SEED_ENABLED=true to run.');
    return;
  }

  const { db, close } = createDbClient(connectionString);

  const workspaceRepo = createWorkspaceRepo(db);
  const agentRepo = createAgentRepo(db);
  const sessionRepo = createSessionRepo(db);
  const apiKeyRepo = createApiKeyRepo(db);

  try {
    console.log('Seeding database...');

    const workspace = await workspaceRepo.create({
      workspaceId: generateWorkspaceId(),
      name: 'Dev Workspace',
    });
    console.log(`  Created workspace: ${workspace.workspaceId}`);

    const apiKey = await apiKeyRepo.create({
      apiKeyId: generateApiKeyId(),
      workspaceId: workspace.workspaceId,
      keyHash: 'dev_seed_hash_placeholder',
      name: 'Dev API Key',
    });
    console.log(`  Created API key: ${apiKey.apiKeyId}`);

    const agent = await agentRepo.create({
      agentId: generateAgentId(),
      workspaceId: workspace.workspaceId,
      name: 'dev-assistant',
      modelConfig: { model: 'anthropic/claude-sonnet' },
      systemPrompt: 'You are a helpful assistant for local development.',
      memoryConfig: { strategy: 'last_n', maxMessages: 50 },
    });
    console.log(`  Created agent: ${agent.agentId}`);

    const session = await sessionRepo.create({
      sessionId: generateSessionId(),
      agentId: agent.agentId,
      userId: 'dev_user',
      metadata: { source: 'seed' },
    });
    console.log(`  Created session: ${session.sessionId}`);

    console.log('Seed complete.');
  } finally {
    await close();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
