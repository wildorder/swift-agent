import type { FastifyInstance } from 'fastify';
import { ControlPlaneClient } from './client.js';
import { startToolRunner } from './tool-runner.js';
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

      // Start the tool runner
      server = await startToolRunner({
        port: listenPort,
        registry: toolsByName,
        apiKey: config.apiKey,
      });

      // Resolve actual port (important when port=0 for OS-assigned port)
      const addr = server.server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;

      // Compute public URL for tool runner
      const publicUrl =
        process.env.TOOL_RUNNER_PUBLIC_URL ?? `http://127.0.0.1:${actualPort}`;

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
