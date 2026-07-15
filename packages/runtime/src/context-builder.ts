import type { AgentRecord, MessageRecord } from '@swiftagent/shared';
import type { ModelMessage } from '@swiftagent/models';
import type { MemoryStrategyImpl } from './memory/strategy.js';

/**
 * Content format for persisted tool-role messages.
 *
 * The loop persists tool results as JSON with this shape so the ContextBuilder
 * can reconstruct provider-facing correlation. Every tool call carries THREE
 * identifiers (see WS-20):
 *  - `swiftCallId`   — Swift Agent's own `tc_…` id (DB record + events).
 *  - `providerCallId`— the provider-native id (OpenAI `tool_call_id`,
 *                      Anthropic `tool_use.id`, or Google's synthesized id).
 *  - `toolName`      — the function name, used by name-correlating providers.
 *
 * Id-correlating providers (OpenAI/Anthropic) echo `providerCallId`;
 * name-correlating providers (Google) echo `toolName`.
 */
export type ToolMessageContent = {
  swiftCallId: string;
  providerCallId: string;
  toolName: string;
  result: string;
};

/** Shape persisted for a single tool call inside an assistant message. */
type PersistedToolCall = {
  swiftCallId: string;
  providerCallId: string;
  toolName: string;
  arguments: unknown;
};

export class ContextBuilder {
  private readonly agent: AgentRecord;
  private readonly memory: MemoryStrategyImpl;

  /**
   * providerCallId → toolName, accumulated from assistant tool calls during a
   * single `build()` pass. Used only to recover the tool name for legacy tool
   * messages that predate the `toolName` field.
   */
  private legacyToolNameByCallId = new Map<string, string>();

  constructor(agent: AgentRecord, memory: MemoryStrategyImpl) {
    this.agent = agent;
    this.memory = memory;
  }

  build(history: MessageRecord[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    this.legacyToolNameByCallId = new Map<string, string>();

    // System message first (if non-empty)
    if (this.agent.systemPrompt) {
      messages.push({ role: 'system', content: this.agent.systemPrompt });
    }

    // Apply memory strategy to trim history
    const trimmed = this.memory.trim(history);

    // Map each MessageRecord to ModelMessage. Assistant messages come before
    // their tool results in history order, so the legacy name map is populated
    // before any tool message needs it.
    for (const record of trimmed) {
      switch (record.role) {
        case 'system':
          // System messages from history are skipped — the agent's
          // systemPrompt is injected above
          break;

        case 'user':
          messages.push({ role: 'user', content: record.content });
          break;

        case 'assistant':
          messages.push(this.mapAssistantMessage(record));
          break;

        case 'tool':
          messages.push(this.mapToolMessage(record));
          break;
      }
    }

    return messages;
  }

  private mapAssistantMessage(record: MessageRecord): ModelMessage {
    // Check if the content contains tool calls (stored as JSON by the loop)
    try {
      const parsed = JSON.parse(record.content) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'text' in parsed &&
        'toolCalls' in parsed &&
        Array.isArray((parsed as Record<string, unknown>).toolCalls)
      ) {
        const data = parsed as {
          text: string;
          toolCalls: Array<Partial<PersistedToolCall> & { callId?: string }>;
        };
        return {
          role: 'assistant',
          content: data.text,
          toolCalls: data.toolCalls.map((tc) => {
            // Providers correlate results by the provider-native id, so the
            // assistant tool call must carry `providerCallId` (never the
            // Swift Agent `tc_…` id). Fall back to a legacy single `callId`.
            const callId = tc.providerCallId ?? tc.callId ?? '';
            const toolName = tc.toolName ?? '';
            if (callId && toolName) {
              this.legacyToolNameByCallId.set(callId, toolName);
            }
            return { callId, toolName, arguments: tc.arguments };
          }),
        };
      }
    } catch {
      // Not JSON — plain text assistant message
    }

    return { role: 'assistant', content: record.content };
  }

  private mapToolMessage(record: MessageRecord): ModelMessage {
    // Tool messages are persisted as JSON carrying the provider-native id and
    // the tool name so both id- and name-correlating providers can round-trip.
    try {
      const parsed = JSON.parse(record.content) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'result' in parsed &&
        ('providerCallId' in parsed || 'toolCallId' in parsed)
      ) {
        const data = parsed as Partial<ToolMessageContent> & {
          // legacy single-id shape
          toolCallId?: string;
          result: string;
        };
        const providerCallId = data.providerCallId ?? data.toolCallId;
        const toolName = data.toolName ?? this.findToolName(providerCallId);
        return {
          role: 'tool',
          content: data.result,
          ...(providerCallId !== undefined ? { toolCallId: providerCallId } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
        };
      }
    } catch {
      // Fallback — shouldn't happen if loop persists correctly
    }

    return { role: 'tool', content: record.content };
  }

  /**
   * Backward-compat helper: for legacy tool messages that lack a `toolName`,
   * derive it from the most recent matching assistant tool call.
   */
  private findToolName(providerCallId: string | undefined): string | undefined {
    if (providerCallId === undefined) return undefined;
    return this.legacyToolNameByCallId.get(providerCallId);
  }
}
