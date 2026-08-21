import { defineAgent } from '@swiftagent/sdk';
import { withBudget } from './tools/budget.js';
import { getWeatherTool } from './tools/weather.js';
import { calculateTool } from './tools/calculate.js';
import { unreliableServiceTool } from './tools/unreliable-service.js';

// The whole demo: three tools, each raced against a demo-owned time budget,
// composed into one agent. This file is served verbatim by /api/demo-config.
export const playgroundTools = [
  withBudget(getWeatherTool, 5_000),
  withBudget(calculateTool, 1_000),
  withBudget(unreliableServiceTool, 1_500),
];

export const playgroundAgent = defineAgent({
  name: 'playground-assistant',
  model: process.env.PLAYGROUND_MODEL ?? 'anthropic/claude-3-5-haiku',
  // WS-49 guardrail: bounds per-round output, which (× the runtime's 10 max
  // tool iterations) anchors the ledger's per-run reservation formula — see
  // deploy/playground/README.md.
  maxTokens: 1024,
  system:
    'You are the Swift Agent playground assistant. Use get_weather for weather ' +
    'questions and calculate for arithmetic. Call unreliable_service only when ' +
    'explicitly asked — it is expected to fail.',
  tools: playgroundTools,
});
