export const PACKAGE_NAME = 'gateway' as const;

// Server
export { createGatewayServer, startGateway } from './server.js';
export type { GatewayContext } from './server.js';

// Plugin (unified realtime server — mounts onto a host Fastify app)
export { registerGatewayPlugin } from './plugin.js';

// Types
export type {
  ChatEvent,
  InboundMessage,
  SendMessage,
  PingMessage,
  ErrorEvent,
  GatewayConfig,
  GatewayPluginConfig,
  GatewayComponents,
  RuntimeDelegate,
  AuthenticatedSocket,
} from './types.js';
export {
  InboundMessageSchema,
  SendMessageSchema,
  PingMessageSchema,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_MAX_REPLAY_BUFFER_SIZE,
} from './types.js';

// Auth
export { validateClientToken, AuthError, AuthErrorCode } from './auth.js';

// Connection manager
export { ConnectionManager } from './connection-manager.js';

// Events
export { serializeChatEvent, parseInboundMessage, toErrorEvent, ParseError } from './events.js';

// Session bridge
export {
  SessionBridge,
  createSessionBridge,
  createNoopRedisPubSub,
  createRedisPubSub,
} from './session-bridge.js';
export type { RedisPubSubStub, RedisMessageHandler, SessionBridgeDeps } from './session-bridge.js';

// Heartbeat
export { HeartbeatManager } from './heartbeat.js';
