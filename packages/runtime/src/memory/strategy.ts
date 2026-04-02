import type { MessageRecord } from '@swiftagent/shared';
import { LastNMemoryStrategy } from './last-n.js';
import { SummaryMemoryStrategy } from './summary.js';

export interface MemoryStrategyImpl {
  trim(messages: MessageRecord[]): MessageRecord[];
}

export type MemoryStrategyName = 'last_n' | 'summary';

export function createMemoryStrategy(
  name: MemoryStrategyName,
  options: { lastN?: number } = {},
): MemoryStrategyImpl {
  switch (name) {
    case 'last_n':
      return new LastNMemoryStrategy({ maxMessages: options.lastN });
    case 'summary':
      return new SummaryMemoryStrategy();
    default:
      throw new Error(`Unknown memory strategy: ${name as string}`);
  }
}
