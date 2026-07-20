import { describe, it, expect } from 'vitest';
import * as sdk from '../index.js';
import * as internal from '../internal.js';

// ── Compile-time public TYPE surface guard ──────────────────────────
// Importing each public type keeps it load-bearing: removing or renaming any
// of these from `../index.js` fails `tsc` (which `pnpm typecheck` runs on src).
import type {
  AgentApp,
  ToolContext,
  ToolDefinition,
  SdkAgentConfig,
  AgentDefinition,
  CreateAgentAppConfig,
  CreateSessionOptions,
  CreateSessionResult,
  ListMessagesOptions,
  ListMessagesResult,
  CreateRunOptions,
  AcceptedRun,
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
} from '../index.js';

type _PublicTypeSurface = [
  AgentApp,
  ToolContext,
  ToolDefinition,
  SdkAgentConfig,
  AgentDefinition,
  CreateAgentAppConfig,
  CreateSessionOptions,
  CreateSessionResult,
  ListMessagesOptions,
  ListMessagesResult,
  CreateRunOptions,
  AcceptedRun,
  AgentRecord,
  SessionRecord,
  MessageRecord,
  RunRecord,
];
type _AssertTuple = _PublicTypeSurface extends unknown[] ? true : never;
const _typeSurface: _AssertTuple = true;
void _typeSurface;

// The runtime (value) exports that must appear at the `@swiftagent/sdk` root.
// Committed inline (not a `.snap` file) so any drift is reviewed in the diff and
// cannot be silently `-u`-updated.
const EXPECTED_ROOT_VALUES = ['createAgentApp', 'defineAgent', 'tool'] as const;

// The value exports reachable via the declared `@swiftagent/sdk/internal` subpath.
const EXPECTED_INTERNAL_VALUES = [
  'ControlPlaneClient',
  'SdkAgentConfigSchema',
  'SdkHttpError',
  'ToolRunnerRequestSchema',
  'startToolRunner',
  'toolToJsonSchema',
] as const;

// Names relocated out of the root barrel into `/internal` (SC-01: not reachable
// from the package root).
const RELOCATED_TO_INTERNAL = [
  'ControlPlaneClient',
  'startToolRunner',
  'toolToJsonSchema',
  'SdkHttpError',
  'ToolRunnerRequestSchema',
  'SdkAgentConfigSchema',
] as const;

describe('@swiftagent/sdk public API surface', () => {
  it('root exposes exactly the vision-advertised value surface', () => {
    expect(Object.keys(sdk).sort()).toEqual([...EXPECTED_ROOT_VALUES]);
  });

  it('each root value export is a function', () => {
    for (const name of EXPECTED_ROOT_VALUES) {
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('/internal carries the low-level escape hatches', () => {
    expect(Object.keys(internal).sort()).toEqual([...EXPECTED_INTERNAL_VALUES]);
  });

  it('relocated internals are NOT reachable from the package root', () => {
    for (const name of RELOCATED_TO_INTERNAL) {
      expect((sdk as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
