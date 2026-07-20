# Policy: Versioning, Deprecation & SDK↔Server Compatibility

This is the standing, normative policy for how the published `@swiftagent/*`
packages are versioned, how the public SDK surface evolves, how symbols are
deprecated and removed, and how the SDK and server agree on a wire-protocol
version at runtime. It governs the packages that ship to consumers
(`@swiftagent/sdk`, `@swiftagent/react`, `@swiftagent/shared`) and the
control-plane + stream contract they speak.

Release *automation* (the publish workflow, registry auth, tags) is **not** in
scope here — it is owned by WS-38. This document defines the rules; WS-38 wires
the machinery that enforces the publish half.

---

## 1. Scope & principles

- **Semantic Versioning (semver 2.0.0) for `@swiftagent/*`.** Every published
  package carries a `MAJOR.MINOR.PATCH` version. The *public surface* of a
  package — what a consumer can import from its declared entry points — is the
  contract semver protects. Anything reachable only through an `/internal`
  subpath or not exported from a package's barrel is **not** part of the
  contract and may change in any release.
- **Changesets is the single source of truth for version intent.** Version bumps
  are never hand-edited into `package.json`. Every user-facing change ships with
  a changeset (`pnpm changeset`) that declares the bump level and a changelog
  line; `pnpm version-packages` (`changeset version`) consumes accumulated
  changesets into the actual version bumps and `CHANGELOG.md` entries. See §6.
- **Packages version independently.** `.changeset/config.json` leaves `fixed` and
  `linked` empty: a change to one package does not force a lockstep bump of the
  others. When a package bumps, workspace dependents that reference it receive a
  **patch** bump (`updateInternalDependencies: "patch"`) to keep the linked
  versions consistent, but the packages otherwise move on their own cadence.
- **Packages are currently private.** Every package is `"private": true` and
  publishes to a **restricted** (private) registry once WS-38 turns publishing
  on. Until then, Changesets still *records* intended bumps; it just does not
  publish. Do not remove `"private": true` as part of a feature change — flipping
  it is a release concern owned by WS-38.

---

## 2. What is breaking (major) vs. minor vs. patch

Classification is made against the **public SDK surface** — the exports reachable
from a package's stable entry points (e.g. `@swiftagent/sdk`,
`@swiftagent/react`, `@swiftagent/shared`). When in doubt, ask: *could an
existing consumer's code stop compiling or stop behaving as documented after
this change?* If yes, it is at least minor; if it forces them to change their
code, it is major.

### MAJOR (breaking) — requires a major bump

- Removing or renaming any public export (value, type, interface, function).
- Removing or renaming a field on a public type, or making an **optional** field
  **required**.
- Narrowing a parameter type, widening a return type, or otherwise tightening
  what a caller may pass / loosening what they can rely on receiving.
- Changing a runtime default in a way that alters existing behavior.
- Changing the meaning of an existing `ChatEvent` variant or removing one.
- Bumping `API_PROTOCOL_VERSION` or `RUNNER_PROTOCOL_VERSION` (a wire-contract
  major — see §4).

### MINOR (additive) — backward-compatible feature

- Adding a new public export.
- Adding an **optional** parameter or an **optional** field to a public type.
- Adding a **new** `ChatEvent` variant that existing consumers can ignore
  (additively consumed — the discriminated union grows, old handlers still
  compile).
- Adding a new method to a client that does not change existing signatures.

### PATCH — no surface change

- An internal bug fix, performance improvement, or docs/typo change with **no**
  change to any public signature or documented behavior.

> Example (this workstream, WS-37): adding the optional
> `CreateSessionResult.serverProtocolVersion` field and the new
> `assertProtocolCompatible` / `PROTOCOL` exports is **minor** — purely additive.
> The new `SwiftAgentErrorCode.INCOMPATIBLE_VERSION` is likewise an additive
> enum member (minor). Nothing was removed, renamed, or made required.

---

## 3. Deprecation & removal window

Public API is removed on a **deliberate schedule**, never abruptly.

1. **Mark, don't remove.** To retire a public symbol, first annotate it with a
   JSDoc `@deprecated` tag that names the replacement and the earliest major in
   which it may be removed:

   ```ts
   /**
    * @deprecated since 2.1 — use {@link createChatSession} instead.
    *   Removed no earlier than 3.0.
    */
   export function openChatSession(/* ... */) { /* ... */ }
   ```

2. **Overlap for at least one minor release.** A deprecated symbol must remain
   fully functional alongside its replacement for **no fewer than one minor
   release** so consumers have a version they can migrate on without a breaking
   bump. The changeset that introduces the deprecation is a **minor** (the
   replacement is additive; the old symbol still works).

3. **Remove only on a major.** Actual removal of a deprecated symbol is a
   **breaking** change and may land **only** in a major release, and only after
   the overlap window above. The removal ships with a **major** changeset and a
   changelog callout that names the removed symbol and its replacement.

4. **Changelog callout.** Both the deprecation and the eventual removal get an
   explicit changelog line (via their changesets), so a consumer reading
   `CHANGELOG.md` between any two versions can see what to migrate and by when.

---

## 4. Protocol versioning

The SDK and server speak two **independent** wire contracts, each with its own
version constant in `@swiftagent/shared`:

| Constant | Governs | Where it lives |
|---|---|---|
| `API_PROTOCOL_VERSION` | The control-plane REST surface (`registerAgent`, session/run endpoints) **and** the `ChatEvent` stream contract the SDK/server speak. | `@swiftagent/shared` (`PROTOCOL.api`) |
| `RUNNER_PROTOCOL_VERSION` | The remote tool-runner wire envelope (`RemoteToolExecutor` ↔ `startToolRunner`) — a hard `z.literal` baked into `RunnerRequestSchema` / `RunnerResponseSchema`. | `@swiftagent/shared` (`PROTOCOL.runner`) |

**Why they are distinct.** The control-plane/stream surface and the tool-runner
envelope evolve on different cadences. Adding a `ChatEvent` variant is a
control-plane protocol change but has nothing to do with the runner
request/response envelope; conversely, tightening the runner envelope has
nothing to do with the stream. Overloading one constant to mean both would force
a runner-schema bump every time an unrelated stream field changes (and vice
versa). Keeping two constants prevents that drift. Both currently sit at major
`'1'`.

The protocol version is a **single monotonic integer major** ("major only"): the
compatibility check parses the major with `Number.parseInt` and ignores any
minor/patch. The **stream contract itself is `ChatEvent` / `ChatEventSchema`** in
`@swiftagent/shared` — a `ChatEvent` change is an `API_PROTOCOL_VERSION`-scoped
concern, classified per §2 (new variant = minor; changed/removed variant =
major).

`SDK_MIN_SERVER_PROTOCOL` (`PROTOCOL.sdkMinServer`) is the **oldest** server
`API_PROTOCOL_VERSION` a given SDK build tolerates. The compatibility check (§5)
compares a server's advertised version against this inclusive floor and the SDK's
own `API_PROTOCOL_VERSION` ceiling.

> These are **compile-time constants, not env vars.** A server does not get to
> "configure" which protocol it speaks — it speaks the one its code compiles
> against. There is deliberately **no** `ENV_KEYS` entry for the protocol
> version; adding one would invite drift between the advertised value and the
> code's actual behavior.

---

## 5. SDK↔server compatibility policy

The server advertises its `API_PROTOCOL_VERSION` on an **additive HTTP response
header**, `x-swiftagent-protocol` (`PROTOCOL.header`), set globally by an
`onSend` hook in `buildApp`. Because it is a header, it is invisible to every
Zod parser and every existing response schema — **zero schema churn**, and it
covers *every* endpoint (including `POST /v1/agents` and `POST /v1/sessions`)
with no per-route work.

The pure function `assertProtocolCompatible(remote, local?)` in
`@swiftagent/shared` is the single decision point. It:

- **Fails open on absence.** A `remote` of `undefined` / `null` / `''` (a legacy
  server that predates the header) returns without throwing, so pointing a new
  SDK at an old server never spuriously fails.
- **Throws `SwiftAgentError(INCOMPATIBLE_VERSION)`** (HTTP status `409`) with an
  **actionable** message on a real mismatch — the message always names *both* the
  observed server version and the SDK's version and tells the reader which side
  to upgrade (server too old → upgrade the server; server too new → upgrade
  `@swiftagent/sdk`; unparseable → the bad value is named).

The SDK asserts compatibility at **two** boundaries:

1. **Registration time (SDK).** `ControlPlaneClient.registerAgent` reads the
   `x-swiftagent-protocol` response header and calls `assertProtocolCompatible`
   **before** parsing the agent record — the first authenticated control-plane
   call fails loudly if the SDK and server disagree.
2. **Connect time (react, client-side).** `ControlPlaneClient.createSession`
   surfaces the same header as `CreateSessionResult.serverProtocolVersion`. The
   `@swiftagent/react` connect path (`createChatSession` / `useAgentChat`) calls
   `assertProtocolCompatible` **before** opening the WebSocket — refusing to
   connect on mismatch (thrown for the vanilla client; surfaced via `lastError`
   for the hook). Because session creation always precedes every stream connect,
   this closes the "connect time" requirement **without touching the WebSocket /
   `ChatEvent` stream protocol at all** — the version rides the session-create
   header the client already fetches.

### Support matrix

For an SDK at `API_PROTOCOL_VERSION = S` with floor `SDK_MIN_SERVER_PROTOCOL = F`,
against a server advertising protocol `P`:

| Condition | Result | Action |
|---|---|---|
| Server omits the header (legacy) | ✅ Supported (fail-open) | None — connect proceeds |
| `F ≤ P ≤ S` | ✅ Supported | None |
| `P < F` (server too old) | ❌ `INCOMPATIBLE_VERSION` | **Upgrade the server** |
| `P > S` (server too new) | ❌ `INCOMPATIBLE_VERSION` | **Upgrade `@swiftagent/sdk`** |
| `P` not an integer | ❌ `INCOMPATIBLE_VERSION` | Fix the malformed advertisement / upgrade |

Concretely, with today's `S = F = 1`:

| SDK major | Server protocol | Outcome |
|---|---|---|
| 1 | (absent) | Supported (fail-open) |
| 1 | 1 | Supported |
| 1 | 2 | Upgrade `@swiftagent/sdk` |
| 1 | 0 | Upgrade the server |

> **Future hardening (not built).** Advertising the protocol version *over the
> WebSocket handshake itself* (a handshake response header or a first control
> frame) would be a stream-protocol-surface change and is intentionally **not**
> implemented — it is unnecessary given the session-create header already gates
> every connect. It is recorded here only as a possible future option.

---

## 6. Releasing (pointer)

The day-to-day author workflow:

1. Make a user-facing change.
2. `pnpm changeset` — select the affected `@swiftagent/*` packages and the bump
   level (major/minor/patch per §2), and write the changelog line.
3. Commit the generated `.changeset/*.md` alongside the code.
4. `pnpm version-packages` (`changeset version`) consumes accumulated changesets
   into version bumps + `CHANGELOG.md` entries when it is time to cut a release.

**The publish/release workflow — building, tagging, and pushing to the private
registry — is owned by WS-38.** This document defines *what* the versions mean
and *when* to bump; WS-38 owns *how* they ship. Do not duplicate the publish
steps here.
