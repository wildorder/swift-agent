import { RUNNER_PROTOCOL_VERSION } from './runner-protocol.js';
import { SwiftAgentError, SwiftAgentErrorCode } from './errors.js';

/**
 * Protocol versioning & compatibility (WS-37).
 *
 * The SDK↔control-plane surface (`registerAgent`, session/run REST, and the
 * `ChatEvent` stream) is a **separate** contract from the tool-runner wire
 * envelope (`RUNNER_PROTOCOL_VERSION`) and versions on a different cadence — e.g.
 * adding a `ChatEvent` variant is a control-plane change but has nothing to do
 * with the runner request/response schema. Keeping the two constants distinct
 * prevents drift between the two boundaries.
 *
 * The protocol version is a single monotonic integer major (documented "major
 * only"): the compatibility check parses the major with `Number.parseInt` and
 * ignores any minor/patch. Values are kept as `string` constants (matching
 * `RUNNER_PROTOCOL_VERSION`'s `'1' as const`) so a wire field could later carry
 * one as a `z.literal`.
 */

/** Control-plane + stream (ChatEvent) protocol version the SDK/server speak.
 *  Distinct from RUNNER_PROTOCOL_VERSION (the tool-runner wire envelope). */
export const API_PROTOCOL_VERSION = '1' as const;

/** Oldest server API_PROTOCOL_VERSION this SDK build tolerates (inclusive floor). */
export const SDK_MIN_SERVER_PROTOCOL = '1' as const;

/** HTTP response header the server advertises its API_PROTOCOL_VERSION on. Lowercase
 *  (fetch/Fastify normalize header names to lowercase). */
export const PROTOCOL_HEADER = 'x-swiftagent-protocol' as const;

/** One import site for every protocol constant. */
export const PROTOCOL = {
  api: API_PROTOCOL_VERSION,
  runner: RUNNER_PROTOCOL_VERSION,
  sdkMinServer: SDK_MIN_SERVER_PROTOCOL,
  header: PROTOCOL_HEADER,
} as const;

/**
 * Assert the local SDK's protocol expectations are compatible with the server's
 * advertised protocol version. Pure — no I/O, safe to unit test in isolation.
 *
 * @param remote  Server-advertised API protocol version, or `undefined`/`null`
 *                when the server did not advertise one (legacy server). Absence
 *                FAILS OPEN (returns without throwing) so a new SDK pointed at an
 *                old server does not spuriously throw.
 * @param local   Optional override of the local {min, current} pair (for tests).
 * @throws SwiftAgentError(INCOMPATIBLE_VERSION) with an actionable message.
 */
export function assertProtocolCompatible(
  remote: string | null | undefined,
  local: { min: string; current: string } = {
    min: SDK_MIN_SERVER_PROTOCOL,
    current: API_PROTOCOL_VERSION,
  },
): void {
  if (remote == null || remote === '') return; // legacy server: fail open

  const remoteMajor = Number.parseInt(remote, 10);
  const minMajor = Number.parseInt(local.min, 10);
  const curMajor = Number.parseInt(local.current, 10);

  if (Number.isNaN(remoteMajor)) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server advertised an unparseable protocol version "${remote}". ` +
        `Expected an integer major (this SDK speaks ${local.current}). ` +
        `Upgrade @swiftagent/sdk or the server.`,
    );
  }

  if (remoteMajor < minMajor) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server protocol ${remote} is older than this SDK supports ` +
        `(minimum ${local.min}, current ${local.current}). Upgrade the Swift Agent server.`,
    );
  }

  if (remoteMajor > curMajor) {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.INCOMPATIBLE_VERSION,
      `Server protocol ${remote} is newer than this SDK understands ` +
        `(this SDK speaks ${local.current}). Upgrade @swiftagent/sdk.`,
    );
  }
}
