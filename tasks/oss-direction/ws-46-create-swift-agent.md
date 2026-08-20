# WS-46: create-swift-agent Scaffold CLI

## Goal

Deliver `create-swift-agent` — a scaffold CLI that produces a runnable agent project (SDK backend with one Zod-schema tool, Vite/React frontend using `useAgentChat`, a compose file matching the WS-43 wiring, `.env.example`) in about a minute — verified **end to end against the WS-45 local Verdaccio registry** rather than public npm.

Four cohesive deliverables:

1. **The package.** A new **unscoped** workspace package at `packages/create-swift-agent` — the only documented exception to the `@swiftagent/*` naming convention, recorded in `AGENTS.md` — **born public-postured**: `publishConfig.registry = https://registry.npmjs.org` with `access: public`, `license: Apache-2.0`, and **no `private` field**. It joins SC-11's four-package public roster and is never swept by WS-44, which precedes it.
2. **The templates.** A single canonical template mirroring `examples/quickstart`'s backend/frontend shape, consuming **only the public SDK surface** under the existing `no-restricted-imports` guard, whose generated compose file defines **exactly one server service with no replica configuration** — single-instance by construction, a LOCAL development artifact explicitly outside SC-12's managed-surface family, asserted in the generated-project test.
3. **The real-npx proof.** `create-swift-agent` is packed and **published INTO the WS-45 Verdaccio registry** (bin entry verified from the packed tarball), and `npx create-swift-agent <name>` resolved **against that registry** produces a project that installs, type-checks, builds, and completes a streaming turn **with a tool call** — the end-to-end CI test owning the same local runtime/API-key/runner bootstrap WS-43 defines.
4. **The release wiring.** `create-swift-agent` is added to the WS-44 release workflow, so the owner's **single** manual `workflow_dispatch` trigger releases it to public npm alongside `@swiftagent/{sdk,react,shared}` (decision 4). This workstream never presses that trigger.

## Traceability

- **SC-06** — Packed and published into the WS-45 local registry (bin verified from the tarball); `npx create-swift-agent <name>` against that registry yields a project that installs, type-checks, builds, and completes a streaming turn with a tool call, its test owning the WS-43-style bootstrap; included in the WS-44 release workflow.
- **SC-11 (part)** — `packages/create-swift-agent/package.json` is born public-postured (registry.npmjs.org, access public, Apache-2.0, no `private` field), completing the four-package public roster; the naming exception is recorded in `AGENTS.md`.
- **SC-12 (part)** — The scaffold-generated compose file defines exactly one server service with no replica configuration; single-instance by construction, asserted in the generated-project test; it is a local artifact outside the managed family.
- **Gate** — `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all green at the checkpoint.

## Dependencies

- **WS-43 — Local Stack Coherence.** Provides the repaired compose wiring (single listener on `API_PORT` 3000, correct `PUBLIC_WEBSOCKET_URL`) the generated compose file mirrors, and the **self-provisioning bootstrap pattern** (server-accepted model config, workspace, raw dev API key with matching stored hash, tool-bearing agent, runner signing/verification keys, deterministic tool-calling fixture) plus the smoke pattern asserting `tool_call_started`/`tool_call_completed`. The generated-project test reuses that bootstrap approach — a freshly generated project has no seeded workspace either. WS-46 does NOT repair root compose or define the bootstrap; it consumes both.
- **WS-44 — Public Release Readiness.** Provides the Apache-2.0 licence + repository LICENSE, the public-posture conventions (publishConfig shape, verify-pack expectations, `.npmrc` no longer routing `@swiftagent` to GitHub Packages), and the **armed manual-`workflow_dispatch` release workflow** designed so this workstream can add `create-swift-agent` to the same release.
- **WS-45 — Local Package Consumption Harness.** Provides the Verdaccio local registry (a real npm registry protocol endpoint), its start/teardown scripts, and a **general publish path** that accepts any workspace package — the registry `create-swift-agent` is published into and that `npx` and the generated project's `@swiftagent/*` installs resolve against.

## Context Files (Agent MUST read before implementing)

- `C:\dev\swift-agent\CLAUDE.md` — conventions (Zod source of truth; ID prefixes; forced verification; grep every reference).
- `C:\dev\swift-agent\docs\programs\oss-direction-manifest.json` — canonical scope: `workstreams[WS-46]`, `successCriteria[SC-06, SC-11, SC-12]`, `constraints.publishingSurfaces`, `constraints.npmGate` (decision 4), `outOfScope[]`.
- `C:\dev\swift-agent\examples\quickstart\backend\src\server.ts` — the backend shape the template mirrors: `tool({ name, description, inputSchema: z.object(...), execute })`, `defineAgent({ name, model, system, tools })`, `createAgentApp({ apiKey, baseUrl })`, `app.agent(...)`, `app.sessions.create(...)`, `app.listen()`, the `/api/session` route pattern, env read at run time not import time.
- `C:\dev\swift-agent\examples\quickstart\frontend\src\App.tsx` — the frontend shape: fetch `/api/session` → `useAgentChat({ sessionId, token, websocketUrl })` → `{ messages, send, isStreaming, connectionStatus, lastError }`; thread `websocketUrl` verbatim, never construct a gateway URL.
- `C:\dev\swift-agent\examples\quickstart\backend\.env.example` — the env surface the template's `.env.example` mirrors: `SWIFT_AGENT_API_KEY`, `SWIFT_AGENT_BASE_URL`, `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, optional `RUNNER_AUDIENCE`/`TOOL_RUNNER_PUBLIC_URL`, `PORT`.
- `C:\dev\swift-agent\examples\quickstart\backend\eslint.config.js` (and the frontend twin) — the **existing `no-restricted-imports` guard**: bans `@swiftagent/*/dist*` and `@swiftagent/*/src*` deep imports. It is configured per-example (extending the root config), not in the root config itself — the template ships the same per-project guard, and the generated project must lint under it.
- `C:\dev\swift-agent\examples\quickstart\backend\package.json` / `frontend\package.json` — dependency and script shape the templates adapt (`@swiftagent/sdk`/`shared`/`react` as real semver deps in the generated project, not `workspace:*`; fastify ^5, zod ^3.24, react ^19, vite).
- `C:\dev\swift-agent\packages\sdk\src\index.ts` — the public SDK surface the backend template may consume: `createAgentApp`, `defineAgent`, `tool` (+ types). Verified export names; nothing else is stable.
- `C:\dev\swift-agent\packages\react\src\index.ts` — the public react surface: `createChatSession`, `useAgentChat` (+ types).
- `C:\dev\swift-agent\packages\sdk\package.json` — the packaging shape to model (exports map, files allowlist with test excludes); post-WS-44 it carries the public posture `create-swift-agent` is born with.
- `C:\dev\swift-agent\docker-compose.yml` — the WS-43-repaired (and by then WS-50-digest-pinned) root wiring the generated compose matches: single server service on port 3000, `DATABASE_URL`/`REDIS_URL` service URLs, `CLIENT_JWT_SECRET`, `PUBLIC_WEBSOCKET_URL: ws://localhost:3000`, `AUTO_MIGRATE`.
- `C:\dev\swift-agent\scripts\verify-pack.mjs` — the pack-verification pattern (pnpm pack + manifest inspection) to mirror for the bin-entry tarball check.
- `C:\dev\swift-agent\.github\workflows\publish-sdks.yml` — the release workflow WS-44 converts to manual `workflow_dispatch` + public npm; this workstream adds `create-swift-agent` to its build filter and publish set.
- `C:\dev\swift-agent\AGENTS.md` (Delivery convention, around line 119) — where the naming-exception record lands.
- `C:\dev\swift-agent\test\smoke\realtime-smoke.ts` — the bounded assertion style for the generated-project streaming test.
- WS-45's harness scripts (path per its spec, e.g. `scripts/local-registry*`) — the registry start/stop/publish interface this workstream calls.

## Package

`packages/create-swift-agent` (NEW), `.github/workflows` (release workflow addition, CI e2e job), `docs/` + `AGENTS.md` (naming exception; CLI usage doc stub — the program-wide quickstart wording is WS-49's).

## Files Touched

- `packages/create-swift-agent/package.json` **(NEW)** — `"name": "create-swift-agent"` (unscoped), `"bin": { "create-swift-agent": "./dist/cli.js" }`, `"license": "Apache-2.0"`, NO `private` field, `publishConfig: { registry: "https://registry.npmjs.org", access: "public" }`, `files: ["dist", "templates", "README.md"]`, scripts `build`/`typecheck`/`lint`/`test` so the turbo gates cover it.
- `packages/create-swift-agent/tsconfig.json`, `eslint.config.js`, `vitest.config.ts` **(NEW)** — matching workspace conventions.
- `packages/create-swift-agent/src/cli.ts` **(NEW)** — entry with `#!/usr/bin/env node` shebang: arg parsing (`node:util` `parseArgs`), interactive prompts, non-interactive mode.
- `packages/create-swift-agent/src/generate.ts` (+ helpers) **(NEW)** — template copy/substitution logic (project name, provider/model, key into `.env`), unit-testable without a TTY.
- `packages/create-swift-agent/templates/**` **(NEW)** — the canonical template: `backend/` (package.json, tsconfig, eslint.config.js with the deep-import guard, `src/server.ts` with one Zod-schema tool + `defineAgent` + `/api/session` route), `frontend/` (Vite + React 19, `useAgentChat` chat UI), `docker-compose.yml` (exactly one server service, no `deploy:`/`replicas`/`scale` keys), `.env.example`, project `README.md`, `.gitignore`.
- `packages/create-swift-agent/src/__tests__/*.test.ts` **(NEW)** — unit tests (prompt/flag parsing, generation output, compose shape assertion).
- `.github/workflows/ci.yml` **(MODIFY)** — a job (or extension of WS-45's harness job) running the end-to-end generated-project test against the local registry.
- `.github/workflows/publish-sdks.yml` **(MODIFY — the WS-44-armed release workflow)** — add `create-swift-agent` to the build filter and the publish set so the owner's single trigger releases all four packages. Do not change its trigger semantics.
- `AGENTS.md` **(MODIFY)** — record the unscoped-name exception: `create-swift-agent` is deliberately unscoped so `npx create-swift-agent` resolves; it is the only exception to the `@swiftagent/*` convention; it is public-postured while every other non-`@swiftagent/{sdk,react,shared}` package remains private.
- `docs/` **(MODIFY, minimal)** — a usage stub for the CLI if needed; the program-wide quickstart/README wording is SC-10 and belongs to WS-49 — do not perform it here.

## Existing Interfaces to Consume

**Public SDK surface** (`packages/sdk/src/index.ts`) — everything the backend template may import:

```typescript
export { createAgentApp } from './app.js';
export { defineAgent } from './agent.js';
export { tool } from './tool.js';
// types: ToolContext, ToolDefinition, AgentDefinition, CreateAgentAppConfig, ...
```

**Public react surface** (`packages/react/src/index.ts`):

```typescript
export { createChatSession } from './client.js';
export { useAgentChat } from './hooks/use-agent-chat.js';
```

**The backend pattern the template adapts** (`examples/quickstart/backend/src/server.ts`):

```typescript
export const echoTool = tool({
  name: 'echo',
  description: 'Echo a message back, optionally shouting it.',
  inputSchema: z.object({ message: z.string().min(1), shout: z.boolean().optional() }),
  execute: async ({ message, shout }, ctx) => {
    const text = shout ? message.toUpperCase() : message;
    return { echoed: text, sessionId: ctx.sessionId };
  },
});

export const supportAgent = defineAgent({
  name: 'support-assistant',
  model: 'anthropic/claude-sonnet',
  system: '…',
  tools: [echoTool],
});
// createAgentApp({ apiKey, baseUrl }) → app.agent(...) → GET /api/session → app.listen()
```

**The frontend pattern** (`examples/quickstart/frontend/src/App.tsx`):

```typescript
const { messages, send, isStreaming, connectionStatus, lastError } = useAgentChat({
  sessionId: session.sessionId,
  token: session.token,
  websocketUrl: session.websocketUrl, // threaded verbatim — never constructed
});
```

**The deep-import guard** (`examples/quickstart/backend/eslint.config.js`) — replicate in both template packages:

```javascript
'no-restricted-imports': ['error', { patterns: [{
  group: ['@swiftagent/*/dist', '@swiftagent/*/dist/*', '@swiftagent/*/src', '@swiftagent/*/src/*'],
  message: 'Import from the package root (e.g. "@swiftagent/sdk") only — deep imports are not part of the public API.',
}] }],
```

**The env surface** (`examples/quickstart/backend/.env.example`) — mirrored by the template's `.env.example`: `SWIFT_AGENT_API_KEY`, `SWIFT_AGENT_BASE_URL` (default `http://127.0.0.1:3000`), `RUNNER_TOKEN_PUBLIC_KEY`, `RUNNER_WORKSPACE_ID`, optional `RUNNER_AUDIENCE`/`TOOL_RUNNER_PUBLIC_URL`, `PORT`, plus the model-provider key the prompts collect.

**The compose wiring** (root `docker-compose.yml`, post-WS-43) — the generated compose mirrors its values (postgres 16, redis 7, `DATABASE_URL`/`REDIS_URL` service URLs, `API_PORT: 3000`, `PUBLIC_WEBSOCKET_URL: ws://localhost:3000`, `AUTO_MIGRATE: 'true'`, `CLIENT_JWT_SECRET` dev value) with **exactly one** server service and no replica configuration.

## Design Notes

- **Born public-postured — this package is never swept.** WS-44's twelve-surface sweep precedes this workstream, so `create-swift-agent` must be created already carrying the public posture: `license: Apache-2.0`, `publishConfig.registry = https://registry.npmjs.org`, `access: public`, no `private` field. If `scripts/verify-pack.mjs` (as updated by WS-44) enumerates publishable packages, extend it to cover `create-swift-agent` with the same assertions; the terminal SC-11 sweep in WS-49 will check this package too.
- **Unscoped on purpose, recorded in AGENTS.md.** `npx create-swift-agent` only resolves an unscoped bin name. This is the single documented exception to `@swiftagent/*` naming; the AGENTS.md Delivery convention gains the exception sentence without weakening the every-other-package-private rule (which remains true — ten private packages at program end).
- **Minimal CLI dependencies.** Prefer Node built-ins: `node:util` `parseArgs` for flags, `node:readline/promises` for interactive prompts. A tiny prompt library is acceptable if genuinely needed, but every runtime dependency ships to every `npx` user — keep the install fast. Prompts: project name (validated as a directory-safe package name) and model provider (`anthropic` | `openai` | `google`) + API key (optional — writing it into the generated `.env`, never committed). Non-interactive flags for CI: e.g. `--name`, `--provider`, `--provider-key`, `--yes` (accept defaults), `--no-install`. Non-interactive mode must never block on a TTY.
- **Templates are files, not string blobs.** Keep `templates/` as a real directory tree included via the `files` allowlist; generation is copy + targeted substitution (project name in package.json/README, provider/model id in the agent definition, key into `.env`). Name template files that must not be interpreted by tooling with a suffix (e.g. `_gitignore`, `package.json.tpl`) if packing or linting would otherwise trip on them — verify from the packed tarball that everything needed actually ships (the `files` allowlist is exactly where a missing `templates/` entry would silently break `npx` for real users while workspace tests pass; same failure class as the workspace-dep `ERR_MODULE_NOT_FOUND` memory note).
- **Generated projects declare real semver deps.** The generated package.jsons depend on `@swiftagent/sdk`/`@swiftagent/react`/`@swiftagent/shared` as normal semver ranges (e.g. `^0.0.1` matching the current workspace versions), NOT `workspace:*` and NOT `file:` paths — the WS-45 registry is what makes this installable pre-release, and public npm makes it installable post-release with zero template changes. Do not special-case unpublished packages in the generated project.
- **Generated compose: single-instance by construction (SC-12).** Exactly one server service; no `deploy.replicas`, no `scale`, no second server-like service. This is a LOCAL development artifact — SC-12 explicitly places it outside the managed-surface family (no rolling deploy or autoscaling to observe) and instead requires the generated-project test to assert the compose shape. Parse the generated YAML in the test and assert: exactly one service whose image/build is the server; no replica-bearing keys.
- **The e2e test owns its bootstrap (SC-06).** A generated project has no seeded workspace, key, agent, or runner keys — the same clean-checkout problem WS-43 solved for the root stack. The e2e test reuses WS-43's bootstrap mechanism (same scripts/fixture, or the same pattern pointed at the generated stack): stand up the runtime, self-provision model config + workspace + raw API key + runner keys, run the generated backend (which registers its agent and hosts its tool via `app.listen()`), then drive one streaming turn with the deterministic tool-calling fixture and assert `tool_call_started` AND `tool_call_completed` (bounded waits, `test/smoke/realtime-smoke.ts` style). The dev bootstrap remains development-only; nothing generated ships it to a deployed environment.
- **Real npx resolution, not a file path.** The CI flow is: start Verdaccio (WS-45 scripts) → publish `@swiftagent/{sdk,react,shared}` AND `create-swift-agent` into it (WS-45's general publish path) → run `npx --registry <verdaccio-url> create-swift-agent <name> --provider … --yes` (or with `npm_config_registry` set) in a temp dir → `npm install` (registry pointed at Verdaccio) → typecheck → build → e2e turn. `npx` must resolve the package through the registry protocol — never `npx ./packages/create-swift-agent` or a tarball path.
- **Bin verified from the packed tarball.** Before publishing to Verdaccio, `pnpm pack` the package and assert from the tarball: `package/package.json` carries the `bin` mapping; the bin target exists in the tarball with the shebang line; `templates/` is present. Mirror the `scripts/verify-pack.mjs` approach.
- **Release wiring, not release.** Add `create-swift-agent` to the WS-44 workflow's build filter (`--filter create-swift-agent...`) and publish set (changesets covers workspace packages that are not `private` — verify `.changeset/config.json` does not `ignore` it). The trigger stays exactly WS-44's manual `workflow_dispatch`; this workstream must not press it, add triggers, or publish to public npm. Provisioning the npm org/token remains owner-owned per the WS-44 runbook.
- **Templates lint in CI.** Either lint the template sources directly (if they are valid TS trees in `templates/`) or rely on the e2e test running `lint` inside the generated project — the deep-import guard must actually execute against the generated code in CI, not merely exist in a template file.

## Out of Scope (restating every manifest exclude)

- Pressing the release trigger — `create-swift-agent`'s real publication fires from the WS-44 `workflow_dispatch` pressed by the owner (decision 4); this workstream adds the package to that workflow and proves it end to end against the local registry.
- The program-wide documentation pass (README quickstart wording, vision ladder statuses, release runbook consistency) — that is SC-10, owned by WS-49.
- Deploy-target configuration for managed hosts (owned by WS-47).
- The playground application (owned by WS-48) — the scaffold's template is intentionally minimal, not the demo.
- Repairing the root `docker-compose.yml` or defining the local bootstrap (owned by WS-43); this consumes that wiring.
- A plugin system, multiple template variants, or framework choices beyond the single canonical template.

## Implementation Steps

1. **Create `packages/create-swift-agent`** with the born-public package.json (unscoped name, bin, Apache-2.0, publishConfig, no `private`), tsconfig/eslint/vitest configs, and wire it into the workspace gates (turbo picks it up via `packages/*`; confirm `pnpm build/typecheck/lint/test` all traverse it).
2. **Author the templates** — backend (one Zod-schema tool + `defineAgent` + `/api/session`, adapted from `examples/quickstart/backend` with real semver `@swiftagent/*` deps), frontend (Vite/React 19 `useAgentChat` chat, adapted from `examples/quickstart/frontend`), single-server compose mirroring the WS-43 wiring, `.env.example`, README, gitignore; both template packages carrying the `no-restricted-imports` guard.
3. **Implement the CLI** — `parseArgs` flags + readline prompts (name, provider, key), non-interactive mode, generation into `<name>/` with substitutions, a friendly post-generate summary (next steps: `docker compose up`, `pnpm dev`, where the dev API key comes from per the WS-43 bootstrap docs).
4. **Unit tests** — flag/prompt parsing (non-interactive path), generation output shape, `.env` writing, and the SC-12 compose assertion (exactly one server service, no replica keys).
5. **Pack verification** — the tarball check for bin + shebang + templates presence (extend or mirror `scripts/verify-pack.mjs`).
6. **End-to-end CI test** — Verdaccio up (WS-45 scripts) → publish all four packages into it → `npx` against the registry → generated project: install → typecheck → build → lint → WS-43-style bootstrap → one streaming turn asserting `tool_call_started` + `tool_call_completed` → teardown. Wire into `ci.yml`.
7. **Release workflow addition** — add `create-swift-agent` to the WS-44 workflow's build/publish set; confirm changesets config includes it; verify with the workflow's dry-run path (never the real trigger).
8. **Record the AGENTS.md exception** and grep the repo for naming-convention statements (`@swiftagent/*` naming rules in AGENTS.md, docs/policies, README) to ensure the exception is stated once and contradicted nowhere. NO SEMANTIC SEARCH: check direct references, docs, workflow filters, changeset config, and test files separately.
9. **Verify the gate.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.

## Tests

1. **Non-interactive generation.** `create-swift-agent my-agent --provider anthropic --yes` in a temp dir produces the full tree (backend, frontend, compose, `.env.example`, README) with the name substituted; exits non-zero with a clear message on an invalid/existing name (SC-06).
2. **Prompt path.** The interactive flow (driven via injected streams, no real TTY in CI) collects name + provider/key and generates identically (SC-06).
3. **Compose shape (SC-12).** Parse the generated `docker-compose.yml`: exactly one server service; no `deploy`, `replicas`, or `scale` keys; port/env wiring matches the WS-43 single-listener contract (`PUBLIC_WEBSOCKET_URL` pointing at the single port).
4. **Packed tarball.** `pnpm pack` output contains `bin` mapping → existing shebanged entry file, plus the complete `templates/` tree (SC-06).
5. **Born-public posture (SC-11).** Assert `packages/create-swift-agent/package.json`: no `private` field, `license === 'Apache-2.0'`, `publishConfig.registry === 'https://registry.npmjs.org'`, `publishConfig.access === 'public'` (a unit test or the extended verify-pack assertion).
6. **End-to-end via the registry (SC-06).** The CI job: publish into Verdaccio → `npx create-swift-agent` resolved against it → generated project installs (`@swiftagent/*` resolved from Verdaccio), type-checks, builds, lints (deep-import guard active) → bootstrap → streaming turn asserting `tool_call_started` AND `tool_call_completed`, all bounded.
7. **Release inclusion.** Assert the release workflow's filters/changeset config cover `create-swift-agent` (a grep-style CI assertion or workflow dry-run evidence) without firing a publish (SC-06).
8. **Gate.** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.

## Acceptance Criteria

1. `packages/create-swift-agent` exists as an unscoped workspace package with its own build and packaging, **born public-postured** — `publishConfig.registry = https://registry.npmjs.org`, `access: public`, `license: Apache-2.0`, no `private` field — joining SC-11's four-package public roster without ever being swept by WS-44 (SC-11).
2. The unscoped name is recorded in `AGENTS.md` as the only documented exception to the `@swiftagent/*` convention, with the every-other-package-private rule left intact (SC-11).
3. `create-swift-agent` is packed and published INTO the WS-45 local registry, its bin entry verified from the packed tarball, and `npx create-swift-agent <name>` is exercised through **real npx resolution against that registry** — never a file path (SC-06).
4. The generated project contains an SDK backend with one Zod-schema tool, a Vite/React frontend using `useAgentChat`, a compose file matching the WS-43 wiring, and `.env.example` (SC-06).
5. The generated compose defines **exactly one server service with no replica configuration**, asserted in the generated-project test — single-instance by construction, as SC-12 names this local artifact (SC-12).
6. Interactive prompts cover project name and model provider/key, with non-interactive flags that run cleanly in CI with no TTY (SC-06).
7. The end-to-end CI test generates against the local registry, then installs, type-checks, builds, and completes a streaming turn **with a tool call** (`tool_call_started` + `tool_call_completed` asserted), the test owning the same local runtime/API-key/runner bootstrap WS-43 defines (SC-06).
8. Templates consume only the public SDK surface (`createAgentApp`/`defineAgent`/`tool`, `useAgentChat`/`createChatSession`) and the generated code is linted under the existing `no-restricted-imports` deep-import guard in CI (SC-06).
9. `create-swift-agent` is included in the WS-44 release workflow so the owner's single manual trigger releases all four packages; this workstream fired no publish and pressed no trigger (SC-06, decision 4).
10. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass (gate).
