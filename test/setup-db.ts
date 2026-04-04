import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('swiftagent_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionUri = container.getConnectionUri();
  process.env['DATABASE_URL'] = connectionUri;
  console.log(`[testcontainers] Postgres started at ${connectionUri}`);

  // Push schema to the test database using raw postgres.js
  const sql = postgres(connectionUri, { max: 1 });

  await sql.unsafe(`
    CREATE TYPE session_status AS ENUM ('active', 'closed');
    CREATE TYPE run_status AS ENUM ('running', 'completed', 'failed');
    CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
    CREATE TYPE tool_call_status AS ENUM ('started', 'completed', 'failed');

    CREATE TABLE workspaces (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      cognito_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE user_workspaces (
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, workspace_id)
    );

    CREATE TABLE api_keys (
      api_key_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      key_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash);
    CREATE INDEX api_keys_workspace_id_idx ON api_keys(workspace_id);

    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      name TEXT NOT NULL,
      model_config JSONB NOT NULL,
      system_prompt TEXT NOT NULL,
      memory_config JSONB NOT NULL,
      tool_runner_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX agents_workspace_id_idx ON agents(workspace_id);
    CREATE UNIQUE INDEX agents_workspace_id_name_idx ON agents(workspace_id, name);

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      user_id TEXT,
      status session_status NOT NULL DEFAULT 'active',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX sessions_agent_id_idx ON sessions(agent_id);
    CREATE INDEX sessions_user_id_idx ON sessions(user_id);

    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      status run_status NOT NULL DEFAULT 'running',
      model VARCHAR(255) NOT NULL,
      token_usage JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX runs_session_id_idx ON runs(session_id);

    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      run_id TEXT REFERENCES runs(run_id),
      role message_role NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX messages_session_id_created_at_idx ON messages(session_id, created_at);
    CREATE INDEX messages_run_id_idx ON messages(run_id);

    CREATE TABLE tool_calls (
      call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      tool_name TEXT NOT NULL,
      input JSONB NOT NULL,
      output JSONB,
      status tool_call_status NOT NULL DEFAULT 'started',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX tool_calls_run_id_idx ON tool_calls(run_id);
  `);
  console.log('[testcontainers] Schema pushed');

  await sql.end();
}

export async function teardown() {
  if (container) {
    await container.stop();
    console.log('[testcontainers] Postgres stopped');
  }
}
