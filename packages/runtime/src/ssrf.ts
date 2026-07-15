import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import { SwiftAgentError, SwiftAgentErrorCode } from '@swiftagent/shared';

/**
 * Outbound SSRF guard for the remote tool-runner boundary (WS-22, SC-09).
 *
 * The defining hazard is DNS rebinding / TOCTOU: validating with one DNS lookup
 * and then letting `fetch` resolve the host a second time lets an attacker
 * return a public IP to the validator and a private IP to the socket. We close
 * that window by resolving ONCE, validating every resolved address, and issuing
 * the request through a dispatcher pinned to the exact validated IP — so the
 * socket can only connect to the address that passed validation.
 */

export interface OutboundUrlPolicy {
  /** Reject non-`https:` URLs (true in deployed environments). */
  requireHttps: boolean;
  /** Permit loopback targets — dev/test only, for a local runner on 127.0.0.1/::1. */
  allowLoopback: boolean;
}

// ── Address classification ───────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isLoopbackV4(n: number): boolean {
  // 127.0.0.0/8
  return (n & 0xff000000) === 0x7f000000;
}

function inCidr(n: number, mask: number, network: number): boolean {
  // `>>> 0` coerces the signed int32 result of `&` back to an unsigned value so
  // ranges whose network address has the high bit set (172.16/12, 192.168/16,
  // 169.254/16) compare correctly.
  return ((n & mask) >>> 0) === network >>> 0;
}

function isDisallowedV4(n: number): boolean {
  return (
    isLoopbackV4(n) || // 127.0.0.0/8 loopback
    inCidr(n, 0xff000000, 0x00000000) || // 0.0.0.0/8 "this network" / unspecified
    inCidr(n, 0xff000000, 0x0a000000) || // 10.0.0.0/8 private
    inCidr(n, 0xfff00000, 0xac100000) || // 172.16.0.0/12 private
    inCidr(n, 0xffff0000, 0xc0a80000) || // 192.168.0.0/16 private
    inCidr(n, 0xffc00000, 0x64400000) || // 100.64.0.0/10 CGNAT
    inCidr(n, 0xffff0000, 0xa9fe0000) // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  );
}

function normalizeV6(ip: string): string {
  // Strip zone id (e.g. fe80::1%eth0) before classification.
  const pct = ip.indexOf('%');
  return (pct === -1 ? ip : ip.slice(0, pct)).toLowerCase();
}

/** True for loopback, link-local, private, CGNAT, unspecified, or cloud-metadata addresses. */
export function isDisallowedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return n === null ? true : isDisallowedV4(n);
  }
  if (kind === 6) {
    const v6 = normalizeV6(ip);
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 unique-local
    // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
    const mapped = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) {
      const n = ipv4ToInt(mapped[1]);
      return n === null ? true : isDisallowedV4(n);
    }
    return false;
  }
  // Not a parseable IP — treat as disallowed (fail closed).
  return true;
}

function isLoopbackAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return n !== null && isLoopbackV4(n);
  }
  if (kind === 6) {
    return normalizeV6(ip) === '::1';
  }
  return false;
}

// ── Validation + pinning ─────────────────────────────────────────────────────

/**
 * Validate an outbound runner URL and resolve the single IP the request MUST
 * connect to. Rejects on scheme, resolution failure, or any resolved address in
 * a blocked range. Returns the parsed URL and the pinned IP for
 * {@link createPinnedDispatcher}.
 */
export async function resolveAllowedOutboundTarget(
  rawUrl: string,
  policy: OutboundUrlPolicy,
): Promise<{ url: URL; pinnedIp: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.VALIDATION,
      `Disallowed runner target: malformed URL`,
    );
  }

  if (policy.requireHttps && url.protocol !== 'https:') {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.VALIDATION,
      `Disallowed runner target: ${url.protocol} scheme requires https`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SwiftAgentError(
      SwiftAgentErrorCode.VALIDATION,
      `Disallowed runner target: unsupported scheme ${url.protocol}`,
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1] literals

  // Resolve the host to every address it advertises. A literal IP is used as-is
  // (no DNS), but is still range-checked below.
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await dnsLookup(hostname, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new SwiftAgentError(
        SwiftAgentErrorCode.VALIDATION,
        `Disallowed runner target: cannot resolve ${hostname}`,
      );
    }
    if (addresses.length === 0) {
      throw new SwiftAgentError(
        SwiftAgentErrorCode.VALIDATION,
        `Disallowed runner target: ${hostname} resolved to no addresses`,
      );
    }
  }

  // Reject if ANY resolved address is disallowed (defeats multi-record rebinding).
  for (const address of addresses) {
    const blocked = isDisallowedAddress(address);
    const loopbackPermitted = policy.allowLoopback && isLoopbackAddress(address);
    if (blocked && !loopbackPermitted) {
      throw new SwiftAgentError(
        SwiftAgentErrorCode.VALIDATION,
        `Disallowed runner target: ${hostname} resolves to blocked address ${address}`,
      );
    }
  }

  return { url, pinnedIp: addresses[0] };
}

/**
 * An `undici` dispatcher that dials `pinnedIp` for every connection while
 * preserving the request's `Host` header and TLS SNI (undici derives SNI from
 * the URL hostname, not the looked-up address). This guarantees the socket
 * connects to the exact address that passed {@link resolveAllowedOutboundTarget}
 * — no re-resolution, no rebinding window (SC-09).
 */
export function createPinnedDispatcher(pinnedIp: string): Dispatcher {
  const family = isIP(pinnedIp) === 6 ? 6 : 4;
  return new Agent({
    connect: {
      // undici calls `lookup` with `{ all: true }`, so the callback must return an
      // array of { address, family } records. We ignore the hostname entirely and
      // always resolve to the single validated (pinned) IP.
      lookup: (
        _hostname: string,
        options: { all?: boolean } | undefined,
        callback: (
          err: Error | null,
          address: string | { address: string; family: number }[],
          family?: number,
        ) => void,
      ): void => {
        if (options?.all) {
          callback(null, [{ address: pinnedIp, family }]);
        } else {
          callback(null, pinnedIp, family);
        }
      },
    },
  });
}
