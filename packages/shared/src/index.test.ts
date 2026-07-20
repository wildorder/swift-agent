import { describe, it, expect } from 'vitest';
import {
  // Package
  PACKAGE_NAME,
  // Constants
  PREFIX_SESSION, PREFIX_MESSAGE, PREFIX_RUN, PREFIX_TOOL_CALL,
  PREFIX_AGENT, PREFIX_WORKSPACE, PREFIX_API_KEY, PREFIX_USER,
  // ID utils
  generateSessionId, generateMessageId, generateRunId,
  generateToolCallId, generateAgentId, generateWorkspaceId,
  generateApiKeyId, generateUserId, parsePrefix,
  // Schemas
  AgentRecordSchema, SessionRecordSchema, MessageRecordSchema,
  RunRecordSchema, ToolCallRecordSchema, WorkspaceRecordSchema,
  ApiKeyRecordSchema, ClientTokenClaimsSchema, ChatEventSchema,
  UserRecordSchema, UserWorkspaceRecordSchema,
  // Errors
  SwiftAgentError, SwiftAgentErrorCode, isSwiftAgentError,
  // Protocol versioning & compatibility (WS-37)
  PROTOCOL, API_PROTOCOL_VERSION, SDK_MIN_SERVER_PROTOCOL,
  PROTOCOL_HEADER, assertProtocolCompatible, RUNNER_PROTOCOL_VERSION,
  // Config
  ENV_KEYS, loadConfig,
} from './index.js';
import type { ChatEvent } from './index.js';

// ─── ID Generation ──────────────────────────────────────────────────────────

describe('ID generation', () => {
  const generators = [
    { fn: generateSessionId, prefix: PREFIX_SESSION, name: 'session' },
    { fn: generateMessageId, prefix: PREFIX_MESSAGE, name: 'message' },
    { fn: generateRunId, prefix: PREFIX_RUN, name: 'run' },
    { fn: generateToolCallId, prefix: PREFIX_TOOL_CALL, name: 'tool-call' },
    { fn: generateAgentId, prefix: PREFIX_AGENT, name: 'agent' },
    { fn: generateWorkspaceId, prefix: PREFIX_WORKSPACE, name: 'workspace' },
    { fn: generateApiKeyId, prefix: PREFIX_API_KEY, name: 'api-key' },
    { fn: generateUserId, prefix: PREFIX_USER, name: 'user' },
  ];

  for (const { fn, prefix, name } of generators) {
    it(`generate${name}Id returns a non-empty string with prefix "${prefix}"`, () => {
      const id = fn();
      expect(id).toBeTruthy();
      expect(id.startsWith(prefix)).toBe(true);
      expect(id.length).toBeGreaterThan(prefix.length);
    });
  }

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('parsePrefix', () => {
  it('extracts prefix from a valid ID', () => {
    expect(parsePrefix('ses_abc123')).toBe('ses_');
    expect(parsePrefix('msg_xyz')).toBe('msg_');
  });

  it('returns null for IDs without underscore', () => {
    expect(parsePrefix('nounderscore')).toBeNull();
  });
});

// ─── Zod Schemas: Valid Payloads ────────────────────────────────────────────

describe('Zod schemas — valid payloads', () => {
  const now = new Date();

  it('AgentRecord parses valid data', () => {
    const result = AgentRecordSchema.safeParse({
      agentId: 'agt_abc',
      workspaceId: 'ws_123',
      name: 'test-agent',
      modelConfig: { model: 'openai/gpt-4' },
      systemPrompt: 'You are helpful.',
      memoryConfig: { strategy: 'last_n', maxMessages: 10 },
      toolRunnerUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('AgentRecord with toolRunnerUrl as valid URL parses', () => {
    const result = AgentRecordSchema.safeParse({
      agentId: 'agt_abc',
      workspaceId: 'ws_123',
      name: 'test-agent',
      modelConfig: { model: 'openai/gpt-4' },
      systemPrompt: 'You are helpful.',
      memoryConfig: { strategy: 'summary' },
      toolRunnerUrl: 'https://example.com/tools',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('SessionRecord parses valid data', () => {
    const result = SessionRecordSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      userId: null,
      status: 'active',
      metadata: { key: 'value' },
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('MessageRecord parses valid data', () => {
    const result = MessageRecordSchema.safeParse({
      messageId: 'msg_abc',
      sessionId: 'ses_def',
      runId: null,
      role: 'user',
      content: 'Hello',
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('RunRecord parses valid data', () => {
    const result = RunRecordSchema.safeParse({
      runId: 'run_abc',
      sessionId: 'ses_def',
      status: 'running',
      model: 'openai/gpt-4',
      tokenUsage: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('ToolCallRecord parses valid data', () => {
    const result = ToolCallRecordSchema.safeParse({
      callId: 'tc_abc',
      runId: 'run_def',
      toolName: 'lookupOrder',
      input: { orderId: '123' },
      output: null,
      status: 'started',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('WorkspaceRecord parses valid data', () => {
    const result = WorkspaceRecordSchema.safeParse({
      workspaceId: 'ws_abc',
      name: 'My Workspace',
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('ApiKeyRecord parses valid data', () => {
    const result = ApiKeyRecordSchema.safeParse({
      apiKeyId: 'ak_abc',
      workspaceId: 'ws_def',
      keyHash: 'sha256:abc123',
      name: 'production-key',
      createdAt: now,
      revokedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('ApiKeyRecord with revokedAt date parses', () => {
    const result = ApiKeyRecordSchema.safeParse({
      apiKeyId: 'ak_abc',
      workspaceId: 'ws_def',
      keyHash: 'sha256:abc123',
      name: 'production-key',
      createdAt: now,
      revokedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('UserRecord parses valid data', () => {
    const result = UserRecordSchema.safeParse({
      userId: 'usr_abc',
      cognitoSub: 'cognito-sub-123',
      email: 'user@example.com',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('UserWorkspaceRecord parses valid data', () => {
    const result = UserWorkspaceRecordSchema.safeParse({
      userId: 'usr_abc',
      workspaceId: 'ws_def',
      role: 'owner',
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('UserWorkspaceRecord parses member role', () => {
    const result = UserWorkspaceRecordSchema.safeParse({
      userId: 'usr_abc',
      workspaceId: 'ws_def',
      role: 'member',
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });
});

// ─── Zod Schemas: Invalid Payloads ──────────────────────────────────────────

describe('Zod schemas — invalid payloads', () => {
  it('AgentRecord fails with wrong prefix', () => {
    const result = AgentRecordSchema.safeParse({
      agentId: 'ses_wrong_prefix',
      workspaceId: 'ws_123',
      name: 'test',
      modelConfig: { model: 'gpt-4' },
      systemPrompt: '',
      memoryConfig: { strategy: 'last_n' },
      toolRunnerUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('AgentRecord fails with missing toolRunnerUrl field', () => {
    const result = AgentRecordSchema.safeParse({
      agentId: 'agt_abc',
      workspaceId: 'ws_123',
      name: 'test',
      modelConfig: { model: 'gpt-4' },
      systemPrompt: '',
      memoryConfig: { strategy: 'last_n' },
      // toolRunnerUrl missing
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('SessionRecord fails with invalid status enum', () => {
    const result = SessionRecordSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      userId: null,
      status: 'invalid_status',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('MessageRecord fails with missing required field', () => {
    const result = MessageRecordSchema.safeParse({
      messageId: 'msg_abc',
      // sessionId missing
      role: 'user',
      content: 'Hello',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('RunRecord fails with invalid status', () => {
    const result = RunRecordSchema.safeParse({
      runId: 'run_abc',
      sessionId: 'ses_def',
      status: 'pending',
      model: 'gpt-4',
      tokenUsage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('ToolCallRecord fails with wrong callId prefix', () => {
    const result = ToolCallRecordSchema.safeParse({
      callId: 'msg_wrongprefix',
      runId: 'run_def',
      toolName: 'test',
      input: {},
      output: null,
      status: 'started',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('WorkspaceRecord fails with empty name', () => {
    const result = WorkspaceRecordSchema.safeParse({
      workspaceId: 'ws_abc',
      name: '',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('ApiKeyRecord fails with missing revokedAt', () => {
    const result = ApiKeyRecordSchema.safeParse({
      apiKeyId: 'ak_abc',
      workspaceId: 'ws_def',
      keyHash: 'hash',
      name: 'key',
      createdAt: new Date(),
      // revokedAt missing (required, must be null or Date)
    });
    expect(result.success).toBe(false);
  });

  it('UserRecord fails with wrong prefix', () => {
    const result = UserRecordSchema.safeParse({
      userId: 'ws_wrong',
      cognitoSub: 'sub-123',
      email: 'user@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('UserRecord fails with invalid email', () => {
    const result = UserRecordSchema.safeParse({
      userId: 'usr_abc',
      cognitoSub: 'sub-123',
      email: 'not-an-email',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('UserRecord fails with empty cognitoSub', () => {
    const result = UserRecordSchema.safeParse({
      userId: 'usr_abc',
      cognitoSub: '',
      email: 'user@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('UserWorkspaceRecord fails with invalid role', () => {
    const result = UserWorkspaceRecordSchema.safeParse({
      userId: 'usr_abc',
      workspaceId: 'ws_def',
      role: 'admin',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('UserWorkspaceRecord fails with wrong userId prefix', () => {
    const result = UserWorkspaceRecordSchema.safeParse({
      userId: 'ws_wrong',
      workspaceId: 'ws_def',
      role: 'owner',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

// ─── ChatEvent Discriminated Union ──────────────────────────────────────────

describe('ChatEvent discriminated union', () => {
  const validEvents = [
    { type: 'message_started', messageId: 'msg_1', runId: 'run_1', sessionId: 'ses_1' },
    { type: 'token', runId: 'run_1', sessionId: 'ses_1', messageId: 'msg_1', text: 'Hello' },
    { type: 'tool_call_started', callId: 'tc_1', runId: 'run_1', sessionId: 'ses_1', toolName: 'lookup' },
    { type: 'tool_call_completed', callId: 'tc_1', runId: 'run_1', sessionId: 'ses_1', toolName: 'lookup', status: 'completed' },
    { type: 'message_completed', messageId: 'msg_1', runId: 'run_1', sessionId: 'ses_1' },
    { type: 'run_failed', runId: 'run_1', sessionId: 'ses_1', code: 'INTERNAL', message: 'Something failed' },
  ];

  for (const event of validEvents) {
    it(`parses valid ${event.type} event`, () => {
      const result = ChatEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });
  }

  it('fails with unknown event type', () => {
    const result = ChatEventSchema.safeParse({
      type: 'unknown_event',
      data: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('fails when required field is missing', () => {
    const result = ChatEventSchema.safeParse({
      type: 'token',
      runId: 'run_1',
      // missing sessionId, messageId, text
    });
    expect(result.success).toBe(false);
  });

  it('supports exhaustive switch narrowing', () => {
    // Compile-time check: exhaustive switch must handle all variants
    function handleEvent(event: ChatEvent): string {
      switch (event.type) {
        case 'message_started': return event.messageId;
        case 'token': return event.text;
        case 'tool_call_started': return event.toolName;
        case 'tool_call_completed': return event.status;
        case 'message_completed': return event.messageId;
        case 'run_failed': return event.message;
      }
    }
    // Runtime validation that the function works
    expect(handleEvent({ type: 'token', runId: 'r', sessionId: 's', messageId: 'm', text: 'hi' })).toBe('hi');
  });
});

// ─── SwiftAgentError ────────────────────────────────────────────────────────

describe('SwiftAgentError', () => {
  it('is instanceof Error', () => {
    const err = new SwiftAgentError(SwiftAgentErrorCode.NOT_FOUND, 'Not found');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SwiftAgentError);
  });

  it('has correct code and default statusCode', () => {
    const err = new SwiftAgentError(SwiftAgentErrorCode.NOT_FOUND, 'Session not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Session not found');
  });

  it('allows custom statusCode override', () => {
    const err = new SwiftAgentError(SwiftAgentErrorCode.INTERNAL, 'Oops', { statusCode: 503 });
    expect(err.statusCode).toBe(503);
  });

  it('preserves cause', () => {
    const cause = new Error('root cause');
    const err = new SwiftAgentError(SwiftAgentErrorCode.PROVIDER_ERROR, 'Model failed', { cause });
    expect(err.cause).toBe(cause);
  });

  it('serializes to JSON for API responses', () => {
    const err = new SwiftAgentError(SwiftAgentErrorCode.VALIDATION, 'Bad input');
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'VALIDATION',
      message: 'Bad input',
      statusCode: 400,
    });
  });

  it('isSwiftAgentError type guard works', () => {
    const err = new SwiftAgentError(SwiftAgentErrorCode.INTERNAL, 'fail');
    expect(isSwiftAgentError(err)).toBe(true);
    expect(isSwiftAgentError(new Error('normal'))).toBe(false);
    expect(isSwiftAgentError(null)).toBe(false);
    expect(isSwiftAgentError('string')).toBe(false);
  });
});

// ─── Protocol versioning & compatibility (WS-37) ────────────────────────────

describe('protocol barrel re-exports', () => {
  it('re-exports the protocol constants and assertion from the barrel', () => {
    expect(API_PROTOCOL_VERSION).toBeDefined();
    expect(SDK_MIN_SERVER_PROTOCOL).toBeDefined();
    expect(PROTOCOL_HEADER).toBeDefined();
    expect(PROTOCOL).toBeDefined();
    expect(typeof assertProtocolCompatible).toBe('function');
  });

  it('PROTOCOL bundle matches its constituents', () => {
    expect(PROTOCOL.header).toBe('x-swiftagent-protocol');
    expect(PROTOCOL.runner).toBe(RUNNER_PROTOCOL_VERSION);
    expect(PROTOCOL.api).toBe(API_PROTOCOL_VERSION);
    expect(PROTOCOL.sdkMinServer).toBe(SDK_MIN_SERVER_PROTOCOL);
  });

  it('exposes the new INCOMPATIBLE_VERSION error code (maps to 409)', () => {
    expect(SwiftAgentErrorCode.INCOMPATIBLE_VERSION).toBe('INCOMPATIBLE_VERSION');
    const err = new SwiftAgentError(SwiftAgentErrorCode.INCOMPATIBLE_VERSION, 'nope');
    expect(err.statusCode).toBe(409);
  });
});

// ─── loadConfig / ENV_KEYS ──────────────────────────────────────────────────

describe('loadConfig', () => {
  const validEnv: Record<string, string> = {
    DATABASE_URL: 'postgresql://localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    CLIENT_JWT_SECRET: 'super-secret-key',
  };

  it('validates successfully with required vars', () => {
    const config = loadConfig(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.REDIS_URL).toBe(validEnv.REDIS_URL);
    expect(config.CLIENT_JWT_SECRET).toBe(validEnv.CLIENT_JWT_SECRET);
    expect(config.API_PORT).toBe(3000); // default
    expect(config.GATEWAY_PORT).toBe(3001); // default
  });

  it('parses optional vars when provided', () => {
    const config = loadConfig({
      ...validEnv,
      OPENAI_API_KEY: 'sk-test',
      API_PORT: '4000',
    });
    expect(config.OPENAI_API_KEY).toBe('sk-test');
    expect(config.API_PORT).toBe(4000);
  });

  it('fails with missing required DATABASE_URL', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://x', CLIENT_JWT_SECRET: 'x' })).toThrow();
  });

  it('fails with missing required REDIS_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'pg://x', CLIENT_JWT_SECRET: 'x' })).toThrow();
  });

  it('fails with missing required CLIENT_JWT_SECRET', () => {
    expect(() => loadConfig({ DATABASE_URL: 'pg://x', REDIS_URL: 'redis://x' })).toThrow();
  });

  it('ENV_KEYS is a single source of truth', () => {
    expect(ENV_KEYS.DATABASE_URL).toBe('DATABASE_URL');
    expect(ENV_KEYS.REDIS_URL).toBe('REDIS_URL');
    expect(ENV_KEYS.CLIENT_JWT_SECRET).toBe('CLIENT_JWT_SECRET');
    expect(ENV_KEYS.OPENAI_API_KEY).toBe('OPENAI_API_KEY');
    expect(ENV_KEYS.API_PORT).toBe('API_PORT');
    expect(ENV_KEYS.GATEWAY_PORT).toBe('GATEWAY_PORT');
  });
});

// ─── ClientTokenClaims ──────────────────────────────────────────────────────

describe('ClientTokenClaims', () => {
  it('parses valid claims', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      permissions: ['chat:send', 'chat:read'],
      exp: 1700000000,
    });
    expect(result.success).toBe(true);
  });

  it('parses claims with optional iss and aud', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      permissions: ['chat:send'],
      exp: 1700000000,
      iss: 'swiftagent',
      aud: 'swiftagent-gateway',
    });
    expect(result.success).toBe(true);
  });

  it('fails with missing sessionId', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      agentId: 'agt_def',
      permissions: [],
      exp: 1700000000,
    });
    expect(result.success).toBe(false);
  });

  it('fails with missing agentId', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      sessionId: 'ses_abc',
      permissions: [],
      exp: 1700000000,
    });
    expect(result.success).toBe(false);
  });

  it('fails when permissions is not a string array', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      permissions: [123, true],
      exp: 1700000000,
    });
    expect(result.success).toBe(false);
  });

  it('fails when exp is not a number', () => {
    const result = ClientTokenClaimsSchema.safeParse({
      sessionId: 'ses_abc',
      agentId: 'agt_def',
      permissions: [],
      exp: 'not-a-number',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Package meta ───────────────────────────────────────────────────────────

describe('@swiftagent/shared', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('shared');
  });
});
