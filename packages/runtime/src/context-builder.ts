import type { AgentRecord, MessageRecord } from '@swiftagent/shared';
import type { ModelMessage } from '@swiftagent/models';
import type { MemoryStrategyImpl } from './memory/strategy.js';

/**
 * Content format for persisted tool-role messages.
 * The loop persists tool results as JSON with this shape so the
 * ContextBuilder can reconstruct the `toolCallId` linkage.
 */
export type ToolMessageContent = {
  toolCallId: string;
  result: string;
};

export class ContextBuilder {
  private readonly agent: AgentRecord;
  private readonly memory: MemoryStrategyImpl;

  constructor(agent: AgentRecord, memory: MemoryStrategyImpl) {
    this.agent = agent;
    this.memory = memory;
  }

  build(history: MessageRecord[]): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // System message first (if non-empty)
    if (this.agent.systemPrompt) {
      messages.push({ role: 'system', content: this.agent.systemPrompt });
    }

    // Apply memory strategy to trim history
    const trimmed = this.memory.trim(history);

    // Map each MessageRecord to ModelMessage
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
        const data = parsed as { text: string; toolCalls: Array<{ callId: string; toolName: string; arguments: unknown }> };
        return {
          role: 'assistant',
          content: data.text,
          toolCalls: data.toolCalls.map((tc) => ({
            callId: tc.callId,
            toolName: tc.toolName,
            arguments: tc.arguments,
          })),
        };
      }
    } catch {
      // Not JSON — plain text assistant message
    }

    return { role: 'assistant', content: record.content };
  }

  private mapToolMessage(record: MessageRecord): ModelMessage {
    // Tool messages are persisted with toolCallId encoded in content as JSON
    try {
      const parsed = JSON.parse(record.content) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'toolCallId' in parsed &&
        'result' in parsed
      ) {
        const data = parsed as ToolMessageContent;
        return {
          role: 'tool',
          content: data.result,
          toolCallId: data.toolCallId,
        };
      }
    } catch {
      // Fallback — shouldn't happen if loop persists correctly
    }

    return { role: 'tool', content: record.content };
  }
}
