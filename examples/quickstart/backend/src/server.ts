import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { createAgentApp, defineAgent, tool } from '@swiftagent/sdk';
import { ENV_KEYS } from '@swiftagent/shared';

/**
 * The single demo tool. Its `inputSchema` is a Zod schema (the SDK's `tool()`
 * rejects anything without a `.safeParse` method) and `execute` is a real
 * handler that receives the validated input plus the invocation `ToolContext`.
 */
export const echoTool = tool({
  name: 'echo',
  description: 'Echo a message back, optionally shouting it.',
  inputSchema: z.object({
    message: z.string().min(1),
    shout: z.boolean().optional(),
  }),
  execute: async ({ message, shout }, ctx) => {
    const text = shout ? message.toUpperCase() : message;
    return { echoed: text, sessionId: ctx.sessionId };
  },
});

/**
 * The single demo agent. Exported (alongside {@link echoTool}) so the unit test
 * can assert its shape without starting a server or touching the network.
 */
export const supportAgent = defineAgent({
  name: 'support-assistant',
  model: 'anthropic/claude-sonnet',
  system:
    'You are a friendly support assistant. Use the echo tool when asked to repeat something.',
  tools: [echoTool],
});

/**
 * Wire up the AgentApp and the tiny HTTP server that mints browser sessions.
 * All environment reads happen here (never at import time) so `tsc`/`vitest`
 * can compile and exercise this module without any cloud credentials.
 */
async function main(): Promise<void> {
  const app = createAgentApp({
    apiKey: process.env.SWIFT_AGENT_API_KEY ?? '',
    baseUrl: process.env.SWIFT_AGENT_BASE_URL,
  });

  app.agent(supportAgent);

  // A friendly heads-up if the runner-token env is missing — `app.listen()`
  // throws below without it, but the literal env names come from the shared
  // single-source-of-truth so the message stays accurate.
  if (!process.env[ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY] || !process.env[ENV_KEYS.RUNNER_WORKSPACE_ID]) {
    console.warn(
      `[example-backend] Set ${ENV_KEYS.RUNNER_TOKEN_PUBLIC_KEY} and ${ENV_KEYS.RUNNER_WORKSPACE_ID} ` +
        '(see .env.example) — app.listen() requires them.',
    );
  }

  const server = Fastify({ logger: true });

  // The browser talks to this route through the Vite dev proxy (`/api` →
  // backend). Permissive CORS is added too so the page works even without the
  // proxy; the workspace API key never leaves this process.
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET,OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  });
  server.options('/api/session', async (_request, reply) => {
    reply.code(204).send();
  });

  // Mint a session for the browser: the frontend gets a short-lived client
  // token + the canonical websocketUrl and never sees the workspace API key.
  server.get('/api/session', async () => {
    const session = await app.sessions.create({
      agentName: 'support-assistant',
      userId: 'demo-user',
    });
    return {
      sessionId: session.sessionId,
      token: session.clientToken,
      websocketUrl: session.websocketUrl,
    };
  });

  // Starts the tool runner (hosting `echo`) and registers the agent with the
  // control plane. Throws unless the runner-token env vars resolve.
  await app.listen();

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4000;
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[example-backend] Session route listening on http://127.0.0.1:${port}/api/session`);
}

// Only start when run directly (`tsx`/`node`), never on import — the unit test
// imports this module for `echoTool`/`supportAgent` and must not boot a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
