import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateWorkspaceId,
  generateAgentId,
  generateSessionId,
  generateRunId,
  generateToolCallId,
} from '@swiftagent/shared';
import type { ModelConfig, MemoryConfig } from '@swiftagent/shared';
import {
  createDbClient,
  createWorkspaceRepo,
  createAgentRepo,
  createSessionRepo,
  createRunRepo,
  createToolCallRepo,
} from '@swiftagent/db';
import type { Db } from '@swiftagent/db';

let db: Db;
let close: () => Promise<void>;

const modelConfig: ModelConfig = { model: 'anthropic/claude-sonnet', temperature: 0.7 };
const memoryConfig: MemoryConfig = { strategy: 'last_n', maxMessages: 50 };

beforeAll(() => {
  const databaseUrl = process.env['DATABASE_URL'];
  expect(databaseUrl).toBeDefined();
  const client = createDbClient(databaseUrl!);
  db = client.db;
  close = client.close;
});

afterAll(async () => {
  await close();
});

/** Seed a workspace → agent → session and return a fresh `running` run. */
async function seedRunningRun() {
  const workspaceRepo = createWorkspaceRepo(db);
  const agentRepo = createAgentRepo(db);
  const sessionRepo = createSessionRepo(db);
  const runRepo = createRunRepo(db);

  const workspace = await workspaceRepo.create({
    workspaceId: generateWorkspaceId(),
    name: `ws-${Date.now()}-${Math.random()}`,
  });
  const agent = await agentRepo.create({
    agentId: generateAgentId(),
    workspaceId: workspace.workspaceId,
    name: `agent-${Date.now()}-${Math.random()}`,
    modelConfig,
    systemPrompt: 'You are helpful.',
    memoryConfig,
  });
  const session = await sessionRepo.create({
    sessionId: generateSessionId(),
    agentId: agent.agentId,
  });
  const run = await runRepo.create({
    runId: generateRunId(),
    sessionId: session.sessionId,
    model: modelConfig.model,
  });
  expect(run.status).toBe('running');
  return { run, session };
}

describe('Run + tool-call conditional terminal transitions (WS-24)', () => {
  it('the enum migration applied: cancel + timeout persist the new statuses', async () => {
    const runRepo = createRunRepo(db);
    const { run: cancelled } = await seedRunningRun();
    const { run: timedOut } = await seedRunningRun();

    const c = await runRepo.cancel(cancelled.runId);
    expect(c?.status).toBe('cancelled');

    const t = await runRepo.timeout(timedOut.runId);
    expect(t?.status).toBe('timed_out');
  });

  it('cancel transitions running→cancelled and later terminal writes are no-ops (SC-13)', async () => {
    const runRepo = createRunRepo(db);
    const { run } = await seedRunningRun();

    const cancelled = await runRepo.cancel(run.runId);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe('cancelled');

    // Every subsequent terminal write must be a no-op (returns null).
    expect(await runRepo.complete(run.runId, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeNull();
    expect(await runRepo.fail(run.runId)).toBeNull();
    expect(await runRepo.timeout(run.runId)).toBeNull();
    expect(await runRepo.cancel(run.runId)).toBeNull();

    // Status is still cancelled — nothing overwrote it.
    const fetched = await runRepo.getById(run.runId);
    expect(fetched!.status).toBe('cancelled');
  });

  it('complete is conditional: fail after complete is a no-op (SC-13)', async () => {
    const runRepo = createRunRepo(db);
    const { run } = await seedRunningRun();

    const completed = await runRepo.complete(run.runId, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(completed!.status).toBe('completed');

    expect(await runRepo.fail(run.runId)).toBeNull();
    expect(await runRepo.cancel(run.runId)).toBeNull();
    expect(await runRepo.timeout(run.runId)).toBeNull();

    const fetched = await runRepo.getById(run.runId);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('tool-call updateResult/fail on a finalized call are no-ops (SC-15)', async () => {
    const toolCallRepo = createToolCallRepo(db);
    const { run } = await seedRunningRun();

    const callId = generateToolCallId();
    await toolCallRepo.create({ callId, runId: run.runId, toolName: 'lookup', input: { q: 1 } });

    // First finalize wins.
    const completed = await toolCallRepo.updateResult(callId, { answer: 42 }, 'completed');
    expect(completed!.status).toBe('completed');
    expect(completed!.output).toEqual({ answer: 42 });

    // A late/duplicate runner response cannot overwrite the finalized call.
    expect(await toolCallRepo.updateResult(callId, { answer: 99 }, 'completed')).toBeNull();
    expect(await toolCallRepo.fail(callId)).toBeNull();

    const [persisted] = await toolCallRepo.listByRun(run.runId);
    expect(persisted!.status).toBe('completed');
    expect(persisted!.output).toEqual({ answer: 42 });
  });

  it('tool-call fail is conditional: updateResult after fail is a no-op (SC-15)', async () => {
    const toolCallRepo = createToolCallRepo(db);
    const { run } = await seedRunningRun();

    const callId = generateToolCallId();
    await toolCallRepo.create({ callId, runId: run.runId, toolName: 'lookup', input: {} });

    const failed = await toolCallRepo.fail(callId);
    expect(failed!.status).toBe('failed');

    expect(await toolCallRepo.updateResult(callId, { late: true }, 'completed')).toBeNull();

    const [persisted] = await toolCallRepo.listByRun(run.runId);
    expect(persisted!.status).toBe('failed');
  });
});
