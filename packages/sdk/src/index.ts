// Core API
export { createAgentApp } from './app.js';
export type { AgentApp } from './app.js';
export { defineAgent } from './agent.js';
export { tool } from './tool.js';

// Advanced/low-level escape hatches (raw control-plane client, tool-runner
// hosting, wire schemas, serialization helpers) live behind the declared,
// unstable `@swiftagent/sdk/internal` subpath — not part of the stable surface.

// Types — type-only
export type {
  ToolContext,
  ToolDefinition,
  SdkAgentConfig,
  AgentDefinition,
  CreateAgentAppConfig,
  CreateSessionOptions,
  CreateSessionResult,
  ListMessagesOptions,
  ListMessagesResult,
  CreateRunOptions,
  AcceptedRun,
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
} from './types.js';
