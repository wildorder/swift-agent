# Runbook: Realtime Operations & MVP Limits

This runbook documents the operational posture the realtime gateway actually ships
with in the single-task MVP: what a single instance can and cannot do, what is lost
on restart, and how `/health` reports Redis. It is the operator reference for the
fanout-correctness and Redis-health work delivered in WS-33, and the companion to the
deploy/drain tuning in WS-31.

> **Horizontal scale is Phase 2.** Everything below describes a **single ECS task**
> (`desired_count = 1`). Cross-instance realtime streaming (instance A publishes, instance
> B forwards to B's sockets), a shared session lock, and durable replay are explicitly out
> of scope for this program. See `docs/programs/realtime-cloud-delivery-program.md` §5
> (AD-02) and its out-of-scope list ("Horizontal multi-instance realtime scaling — Phase 2").

---

## 1. Overview & principles

- **One task, one process, no cross-instance coordination.** The MVP runs a single
  Fastify instance serving REST + WebSocket on one port. All realtime state — active
  connections, replay buffers, session locks, in-flight runs — lives **in that process's
  memory**. Nothing is shared across instances, because there is only one instance.
- **Local broadcast is authoritative for locally-connected sockets.** A run event is
  delivered to every socket on this instance exactly once, synchronously, in-process, via
  `ConnectionManager.broadcast`. The Redis pub/sub path exists but delivers **nothing to
  local sockets** on a single instance (see §2).
- **Redis is wired but dormant.** `session:{sessionId}` pub/sub is a config flip
  (`REDIS_URL` set → enabled), kept live so horizontal scale is a flip in Phase 2, not a
  rewrite. On a single instance it carries no local delivery; its only operational effect
  today is that `/health` reports its reachability (§7).
- **A restart is a hard boundary.** In-flight runs, replay buffers, and session locks do
  **not** survive a process restart or deploy. This is intended for the MVP (durable
  execution is Phase 2). Operators should expect active runs to be abandoned on deploy.

---

## 2. Fanout semantics (single instance)

For a session `S` with sockets `{a, b}` on the one instance, when the runtime emits event
`E`:

- **`ConnectionManager.broadcast(S, E)` delivers `E` to `a` and `b` exactly once each.**
  This is the source of truth for locally-connected sockets.
- **`redis.publish('session:S', E)` is for the *future* multi-instance case.** It is what a
  *different* instance's sockets would consume. On a single instance there is no other
  instance, so the publish has **no local consumer** — the local subscription must **not**
  re-deliver `E` to `a`/`b`.

The subscription is **ref-counted per session per instance** (`ChannelRegistry`): the first
socket for `S` subscribes once; later sockets bump a refcount; the channel is unsubscribed
only when the **last** socket for `S` closes. Published events are tagged with the
originating instance's id, and the subscription handler **drops events that originated on
this instance** (already delivered by `broadcast`) — so single-instance delivery is
**exactly-once with zero misses**, and the cross-instance forward (a *peer* instance's event
→ this instance's sockets) is the Phase 2 activation of the same path.

> Historical note: before WS-33 the subscription was per-socket and keyed only by channel, so
> each socket's publish echoed back and was re-delivered (double-delivery), the last
> `subscribe` overwrote the others (missed delivery), and the first socket's `close`
> unsubscribed the channel out from under its siblings (premature teardown). WS-33 fixed all
> three; the local `broadcast` path is unchanged.

---

## 3. Process-local replay buffer

- `SessionBridge.replayBuffers` is an **in-memory, per-session** map holding the active
  run's events, capped at `DEFAULT_MAX_REPLAY_BUFFER_SIZE` (**200** events; older events past
  the cap are not buffered).
- On reconnect **to the same instance while the run is still active**, the buffered events are
  replayed to the reconnecting socket (`replayEvents`). See §5 for the exact conditions.
- **The buffer is lost on instance restart.** A client that reconnects after a deploy or crash
  gets **no replay** — the buffer that held its run's events died with the process. There is no
  cross-instance or durable replay in the MVP.

---

## 4. Process-bound session lock

- `SessionLock` (`packages/runtime/src/session-lock.ts`) is an **in-memory** map that prevents
  **concurrent runs on the same session within one process**. A second `start` for a locked
  session throws `SwiftAgentError(CONFLICT)` → surfaced to the client as `RUN_IN_PROGRESS`.
- Because it is process-bound, it holds **only within a single instance**. Across instances
  (Phase 2) it does **not** hold — two instances could each start a run for the same session.
  This is acceptable in the MVP precisely because there is only one instance; a shared
  (Redis-backed) lock is Phase 2 work.

---

## 5. In-flight runs & reconnect-replay on deploy/restart

- **Runs are process-bound and abandoned on restart.** Execution is not durable in the MVP
  (per the Phase 2 durable-execution boundary noted in `apps/server/src/container.ts`). A
  deploy or crash ends any in-flight run; it is **not** resumed on the new task.
- **Graceful shutdown drains sockets but does not resume runs.** On `SIGTERM`/`SIGINT` the
  server drains WebSockets with close code **1001** ("going away") and tears down
  heartbeats and the session bridge (WS-30 / WS-31), bounded by the ECS `stopTimeout` and ALB
  deregistration delay. Draining is about closing sockets cleanly — it does **not** checkpoint
  or hand off active runs.
- **Reconnect-replay is same-instance and active-run only.** Buffered events are replayed on
  reconnect **only while the run is still active AND only on the same instance** that holds the
  buffer. After a restart (new instance/process), or after the run has reached a terminal state
  (buffer cleared), a reconnecting client gets **no replay**. There is no cross-instance replay.

---

## 6. Single-task posture

- The ECS service is pinned to **`desired_count = 1`** (set in WS-31's Terraform; documented
  here). The MVP intentionally runs exactly one task.
- **Why:** none of the cross-instance machinery exists yet — no shared replay, no shared
  session lock, no cross-instance fanout. A second task would break the invariants in §2–§5
  (a session's sockets could land on different instances with no coordination). Scaling out is
  a Phase 2 activity that lights up the already-wired Redis path and adds shared lock/replay.
- **Deploys are still safe at one task** because the drain path (§5) closes sockets with 1001
  and clients reconnect to the new task; only in-flight runs are lost, which is the documented
  MVP behavior.

---

## 7. Redis health

- `/health` reports `checks.redis` as one of **`'ok' | 'error' | 'disabled'`**:
  - **`'disabled'`** (HTTP **200**) — Redis is off (`REDIS_URL` unset). The real ping is never
    called in this state.
  - **`'ok'`** (HTTP **200**) — Redis is enabled and a real `PING` returned `PONG`.
  - **`'error'`** (HTTP **503**) — Redis is **enabled but unreachable**: the `PING` failed,
    returned a non-`PONG` reply, or timed out (~1s bound).
- The probe is a **real `PING`** issued on the gateway's existing pub/sub connection (no extra
  socket is opened for health), bounded by a ~1s timeout so a hung Redis cannot hang `/health`.
  It never throws — any failure resolves to `false` → `'error'`.
- **Operator reading:** a `503` with `checks.redis: 'error'` while `checks.db: 'ok'` means the
  app is up but its Redis dependency is down/unreachable. Because Redis carries no local
  delivery on a single instance (§2), this does **not** by itself stop realtime streaming to
  locally-connected clients — but it does signal that the (Phase 2) fanout substrate is
  unhealthy and should be investigated before scaling out.

---

## 8. Phase 2 boundary (cross-reference)

Horizontal multi-instance realtime scaling is **out of scope** for this program and reserved
for Phase 2:

- **Cross-instance streaming** — instance A publishes to `session:S`; instance B (holding some
  of `S`'s sockets) forwards to them. The `ChannelRegistry` handler already forwards
  peer-originated events; it is exercised only trivially in the single-task MVP.
- **Shared session lock** — a Redis-backed lock so the §4 concurrency guarantee holds across
  instances.
- **Durable replay** — replay that survives instance restart and works across instances.

See `docs/programs/realtime-cloud-delivery-program.md` §5 (AD-02) and its out-of-scope list.
Until then, operate as a single task per §6.
