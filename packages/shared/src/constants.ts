// ID prefix constants
export const PREFIX_SESSION = 'ses_' as const;
export const PREFIX_MESSAGE = 'msg_' as const;
export const PREFIX_RUN = 'run_' as const;
export const PREFIX_TOOL_CALL = 'tc_' as const;
export const PREFIX_AGENT = 'agt_' as const;
export const PREFIX_WORKSPACE = 'ws_' as const;
export const PREFIX_API_KEY = 'ak_' as const;
export const PREFIX_TRACE = 'tr_' as const;
export const PREFIX_SPAN = 'sp_' as const;

// Event type string literals
export const EVENT_MESSAGE_STARTED = 'message_started' as const;
export const EVENT_TOKEN = 'token' as const;
export const EVENT_TOOL_CALL_STARTED = 'tool_call_started' as const;
export const EVENT_TOOL_CALL_COMPLETED = 'tool_call_completed' as const;
export const EVENT_MESSAGE_COMPLETED = 'message_completed' as const;
export const EVENT_RUN_FAILED = 'run_failed' as const;

// Default limits
export const DEFAULT_NANOID_LENGTH = 21;
export const DEFAULT_MAX_MESSAGES = 50;
