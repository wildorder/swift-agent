import type { MessageRecord } from '@swiftagent/shared';
import type { MemoryStrategyImpl } from './strategy.js';

export class LastNMemoryStrategy implements MemoryStrategyImpl {
  private readonly maxMessages: number;

  constructor(opts?: { maxMessages?: number }) {
    this.maxMessages = opts?.maxMessages ?? 50;
  }

  trim(messages: MessageRecord[]): MessageRecord[] {
    // System messages are excluded from the count — they're injected
    // separately by the ContextBuilder
    const nonSystem = messages.filter((m) => m.role !== 'system');

    if (nonSystem.length <= this.maxMessages) {
      return nonSystem;
    }

    return nonSystem.slice(-this.maxMessages);
  }
}
