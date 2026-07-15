import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { importSPKI, importJWK } from 'jose';
import { ENV_KEYS } from '@swiftagent/shared';
import { ControlPlaneClient } from './client.js';
import { startToolRunner } from './tool-runner.js';
import type { RunnerVerifyKey } from './runner-token.js';
import type {
  AgentDefinition,
  CreateAgentAppConfig,
  ToolDefinition,
  ToolRegistry,
  CreateSessionOptions,
  CreateSessionResult,
  CreateRunOptions,
  ListMessagesOptions,
  ListMessagesResult,
  SessionRecord,
  RunRecord,
} from './types.js';

const DEFAULT_PORT = 8787;
const RUNNER_TOKEN_ALG = 'EdDSA';

/**
 * Resolve a concrete port. When `port` is 0 (OS-assigned), probe a free port by
 * briefly binding then releasing it, so the runner URL / token audience can be
 * computed before the runner binds. Minor TOCTOU is acceptable for local/dev use.
 */
async function resolveConcretePort(port: number): Promise<number> {
  if (port !== 0) return port;
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo | null;
      const resolved = address ? address.port : 0;
      probe.close(() => resolve(resolved));
    });
  });
}

/** Import the runner's public verification key from PEM (SPKI) or JWK JSON. */
async function importRunnerPublicKey(material: string): Promise<RunnerVerifyKey> {
  const trimmed = material.trim();
  if (trimmed.startsWith('{')) {
    return (await importJWK(JSON.parse(trimmed), RUNNER_TOKEN_ALG)) as RunnerVerifyKey;
  }
  return importSPKI(trimmed, RUNNER_TOKEN_ALG);
}

export interface AgentApp {
  /**
   * Register an agent definition. Duplicate tool names across agents throw.
   */
  agent(definition: AgentDefinition): AgentApp;

  /**
   * Session management helpers delegating to the control plane API.
   */
  sessions: {
    create(opts: CreateSessionOptions): Promise<CreateSessionResult>;
    get(id: string): Promise<SessionRecord>;
    messages: {
      list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult>;
    };
  };

  /**
   * Run management helpers delegating to the control plane API.
   */
  runs: {
    create(opts: CreateRunOptions): Promise<RunRecord>;
  };

  /**
   * Start the tool runner and register all agents with the control plane.
   */
  listen(port?: number): Promise<void>;

  /**
   * Stop the tool runner server.
   */
  close(): Promise<void>;
}

/**
 * Create a new AgentApp instance.
 */
export function createAgentApp(config: CreateAgentAppConfig): AgentApp {
  if (!config.apiKey) {
    throw new Error('apiKey is required');
  }

  const client = new ControlPlaneClient(config.apiKey, config.baseUrl);
  const agents: AgentDefinition[] = [];
  const toolsByName: ToolRegistry = new Map();
  let server: FastifyInstance | null = null;

  const app: AgentApp = {
    agent(definition: AgentDefinition): AgentApp {
      // Merge tools, checking for duplicates across all registered agents
      for (const t of definition.tools) {
        if (toolsByName.has(t.name)) {
          throw new Error(
            `Duplicate tool name "${t.name}" — already registered by another agent`,
          );
        }
        toolsByName.set(t.name, t as ToolDefinition);
      }

      agents.push(definition);
      return app;
    },

    sessions: {
      create(opts: CreateSessionOptions): Promise<CreateSessionResult> {
        return client.createSession({
          agentName: opts.agentName,
          userId: opts.userId,
          metadata: opts.metadata,
        });
      },

      get(id: string): Promise<SessionRecord> {
        return client.getSession(id);
      },

      messages: {
        list(sessionId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult> {
          return client.listMessages(sessionId, opts);
        },
      },
    },

    runs: {
      create(opts: CreateRunOptions): Promise<RunRecord> {
        return client.createRun(opts.sessionId, { content: opts.content });
      },
    },

    async listen(port?: number): Promise<void> {
      const listenPort = port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT);

      // ── Resolve scoped-token verification config (WS-22) ──────────────────
      // The token audience MUST equal the runner URL registered with the control
      // plane (the runtime mints `aud = agent.toolRunnerUrl`). Both derive from a
      // single `publicUrl`, so resolve a concrete port up front — for an
      // OS-assigned port (0) we probe a free port before binding the runner — and
      // reuse it for the audience and the registration.
      const actualPort = await resolveConcretePort(listenPort);
      const publicUrl =
        process.env[ENV_KEYS.TOOL_RUNNER_PUBLIC_URL] ?? `http://127.0.0.1:${actualPort}`;

      const publicKeyMaterial = config.runnerPublicKey ?? process.env[ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY];
      if (!publicKeyMaterial) {
        throw new Error(
          `Runner verification requires ${ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY} (PEM or JWK)`,
        );
      }
      const expectedWorkspaceId = config.runnerWorkspaceId ?? process.env[ENV_KEYS.RUNNER_WORKSPACE_ID];
      if (!expectedWorkspaceId) {
        throw new Error(`Runner verification requires ${ENV_KEYS.RUNNER_WORKSPACE_ID}`);
      }
      const expectedAudience =
        config.runnerAudience ?? process.env[ENV_KEYS.RUNNER_AUDIENCE] ?? publicUrl;
      const publicKey = await importRunnerPublicKey(publicKeyMaterial);

      server = await startToolRunner({
        port: actualPort,
        registry: toolsByName,
        auth: { publicKey, expectedAudience, expectedWorkspaceId },
      });

      // Register all agents with the control plane
      for (const agent of agents) {
        await client.registerAgent({
          name: agent.name,
          modelConfig: { ...agent.modelConfig },
          systemPrompt: agent.systemPrompt,
          memoryConfig: agent.memoryConfig ? { ...agent.memoryConfig } : undefined,
          tools: agent.toolSchemas.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
          toolRunnerUrl: publicUrl,
        });
      }

      console.log(`[swiftagent/sdk] Tool runner listening on port ${actualPort}`);
    },

    async close(): Promise<void> {
      if (server) {
        await server.close();
        server = null;
      }
    },
  };

  return app;
}
