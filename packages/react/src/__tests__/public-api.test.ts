import { describe, it, expect } from 'vitest';
import * as react from '../index.js';

// ── Compile-time public TYPE surface guard ──────────────────────────
// Importing each retained public type keeps it load-bearing: removing or
// renaming any from `../index.js` fails `tsc`. `UseConnectionOptions` /
// `UseConnectionResult` are intentionally NOT imported — they are no longer
// root-exported (M-002).
import type {
  ChatEvent,
  ChatMessage,
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
  ReconnectOptions,
  ToolCallInfo,
  UseAgentChatArgs,
  UseAgentChatResult,
} from '../index.js';

type _PublicTypeSurface = [
  ChatEvent,
  ChatMessage,
  ChatSessionClient,
  ConnectionStatus,
  CreateChatSessionOptions,
  ReconnectOptions,
  ToolCallInfo,
  UseAgentChatArgs,
  UseAgentChatResult,
];
type _AssertTuple = _PublicTypeSurface extends unknown[] ? true : never;
const _typeSurface: _AssertTuple = true;
void _typeSurface;

// Runtime (value) exports that must appear at the `@swiftagent/react` root —
// exactly the vision surface (no `useConnection`). Committed inline so drift is
// reviewed in the diff.
const EXPECTED_ROOT_VALUES = ['createChatSession', 'useAgentChat'] as const;

// Names removed from the root barrel (reducer/state internals + useConnection).
const REMOVED_FROM_ROOT = [
  'chatReducer',
  'initialChatState',
  'useConnection',
] as const;

describe('@swiftagent/react public API surface', () => {
  it('root exposes exactly the vision-advertised value surface', () => {
    expect(Object.keys(react).sort()).toEqual([...EXPECTED_ROOT_VALUES]);
  });

  it('each root value export is a function', () => {
    for (const name of EXPECTED_ROOT_VALUES) {
      expect(typeof (react as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('removed internals are NOT reachable from the package root', () => {
    for (const name of REMOVED_FROM_ROOT) {
      expect((react as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
