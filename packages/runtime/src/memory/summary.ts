import type { MessageRecord } from '@swiftagent/shared';
import type { MemoryStrategyImpl } from './strategy.js';

export class SummaryMemoryStrategy implements MemoryStrategyImpl {
  trim(messages: MessageRecord[]): MessageRecord[] {
    // Phase 2 feature — summary strategy is not yet implemented.
    // Passes through unchanged with a warning.
    console.warn(
      '[SummaryMemoryStrategy] Summary memory strategy is not yet implemented. ' +
        'Messages will be passed through without summarization.',
    );
    return messages;
  }
}
