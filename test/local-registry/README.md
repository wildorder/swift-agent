# Local Registry Harness (WS-45)

An ephemeral, loopback-only **Verdaccio** npm registry for verifying that the
workspace packages install as **real npm dependencies before anything is
published**. It is a real registry-protocol HTTP endpoint — NOT a directory of
tarballs or `file:` dependencies, which SC-05 explicitly rules out — because
downstream proofs (`npx create-swift-agent`, WS-46) speak only the registry
protocol.

Everything here is **test-time only**: `verdaccio` is a ROOT devDependency,
nothing under any `packages/*/src` references this harness, and the harness
files live outside every publishable `files` allowlist.

## Subcommands

All via the committed orchestrator `scripts/local-registry.mjs`:

```sh
node scripts/local-registry.mjs start            # spawn Verdaccio (detached), poll /-/ping (~30s bound), write state file
node scripts/local-registry.mjs stop             # kill it + delete ephemeral storage (idempotent — safe when nothing runs)
node scripts/local-registry.mjs publish <dir>... # pnpm publish --registry http://127.0.0.1:<port> --no-git-checks, per dir
node scripts/local-registry.mjs verify           # full end-to-end SC-05 flow (below)
pnpm verify:local-registry                       # alias for `verify` (the CI command)
```

`verify` = start → publish `@swiftagent/{sdk,react,shared}` (building them
first if `dist/` is missing) → assert each version landed locally (`npm view
--registry`) → run the WS-44 install harness (`test/acceptance/install-published.ts`)
against the local endpoint (`SWIFTAGENT_INSTALL_REGISTRY` +
`SWIFTAGENT_RUN_INSTALL_PROOF=1` + dummy `NODE_AUTH_TOKEN`) → assert
**resolved-URL provenance** (every `@swiftagent/*` entry in the consumer's
lockfile resolves from `http://127.0.0.1:<port>/`) → stop.

## Knobs

| Env var | Default | Meaning |
| --- | --- | --- |
| `SWIFTAGENT_LOCAL_REGISTRY_PORT` | `4873` | Listen port (dodge collisions) |

State (PID, port, storage path, publish-side npmrc) is written to a per-port
file in the OS temp dir, so `stop` works from a different process than `start`.

## Why `@swiftagent/*` and `create-swift-agent` have NO uplink

The package rules in `verdaccio.yaml` give our names `access: $all`,
`publish: $all` and **no `proxy`**: a lookup resolves locally or **404s** —
it never leaks to `registry.npmjs.org`. Pre-release nothing exists there, and
post-release the wrong (real) artifact would silently mask a local-publish
failure. Everything else (`**`) proxies to the `npmjs` uplink so a consumer's
whole dependency tree (e.g. the throwaway consumer's `typescript`, or a
scaffolded project's deps) installs through this single endpoint.

The unscoped `create-swift-agent` rule is **pre-provisioned for WS-46**, which
publishes the scaffold CLI into this registry and resolves it via real `npx`.

## WS-46 / scaffold + example verification pattern

```sh
node scripts/local-registry.mjs start
node scripts/local-registry.mjs publish packages/sdk packages/react packages/shared
node scripts/local-registry.mjs publish packages/create-swift-agent
npx --registry http://127.0.0.1:4873 create-swift-agent my-app
node scripts/local-registry.mjs stop
```

`publish` accepts **any** package directory (the three-package roster is only
`verify`'s default), publishing with pnpm so `workspace:*` deps are rewritten
to concrete versions exactly as a real release would. npm clients require an
`_authToken` to publish even though the server never verifies one, so the
orchestrator supplies a dummy token via an isolated per-run npmrc.

## Security: loopback only

The registry listens on `127.0.0.1` with auth relaxed (`max_users: -1`,
publish open to `$all`). Loopback binding **is** the security boundary —
**never** expose this registry beyond localhost / a CI runner, and never point
a real publish at it (nor this harness at a real registry).

## Teardown guarantees

- Storage is a **fresh temp dir per run** (Verdaccio would 409 a re-publish of
  an existing version; fresh storage makes re-runs clean by construction).
- `verify` tears down via `try/finally` plus SIGINT/SIGTERM handlers: a red
  run leaves no listening process, no storage dir, no state file.
- `stop` is idempotent and also cleans up stale state after a crashed run.
