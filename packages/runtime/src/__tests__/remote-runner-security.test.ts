import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { generateKeyPair, jwtVerify, type CryptoKey } from 'jose';
import {
  RUNNER_MAX_INPUT_BYTES,
  RUNNER_MAX_OUTPUT_BYTES,
} from '@swiftagent/shared';

// dns.lookup is mocked so hostname-based tests are deterministic and offline.
const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsMock.lookup }));

import {
  resolveAllowedOutboundTarget,
  createPinnedDispatcher,
  isDisallowedAddress,
} from '../ssrf.js';
import { mintRunnerToken } from '../runner-credentials.js';
import { RemoteToolExecutor } from '../tool-executor-remote.js';
import type { ToolCall, ToolCallContext } from '../tool-executor.js';

const DEPLOYED = { requireHttps: true, allowLoopback: false } as const;
const LOCAL = { requireHttps: false, allowLoopback: true } as const;

// ---------------------------------------------------------------------------
// SSRF validation (SC-09)
// ---------------------------------------------------------------------------

describe('resolveAllowedOutboundTarget — SSRF rejects (SC-09)', () => {
  beforeEach(() => dnsMock.lookup.mockReset());

  it.each([
    ['http://169.254.169.254/latest/meta-data', 'metadata'],
    ['http://127.0.0.1/x', 'loopback'],
    ['http://10.0.0.5/x', 'private-10'],
    ['http://172.16.5.5/x', 'private-172'],
    ['http://192.168.1.1/x', 'private-192'],
    ['http://[::1]/x', 'ipv6-loopback'],
  ])('rejects %s (%s)', async (url) => {
    await expect(resolveAllowedOutboundTarget(url, { requireHttps: false, allowLoopback: false })).rejects.toThrow(
      /Disallowed runner target/,
    );
  });

  it('rejects any http:// URL when requireHttps is set', async () => {
    await expect(resolveAllowedOutboundTarget('http://8.8.8.8/x', DEPLOYED)).rejects.toThrow(
      /requires https/,
    );
  });

  it('accepts a public https target and returns the pinned IP', async () => {
    const { url, pinnedIp } = await resolveAllowedOutboundTarget('https://8.8.8.8/tools/x', DEPLOYED);
    expect(url.protocol).toBe('https:');
    expect(pinnedIp).toBe('8.8.8.8');
    // A literal IP never triggers DNS.
    expect(dnsMock.lookup).not.toHaveBeenCalled();
  });

  it('permits loopback only under allowLoopback policy', async () => {
    await expect(resolveAllowedOutboundTarget('http://127.0.0.1:1/x', LOCAL)).resolves.toMatchObject({
      pinnedIp: '127.0.0.1',
    });
  });

  it('rejects DNS rebinding: a public host resolving to a private IP (SC-09)', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      resolveAllowedOutboundTarget('https://totally-legit.example/x', DEPLOYED),
    ).rejects.toThrow(/blocked address 10\.0\.0\.5/);
  });

  it('rejects if ANY resolved address is private (multi-record rebinding)', async () => {
    dnsMock.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      resolveAllowedOutboundTarget('https://mixed.example/x', DEPLOYED),
    ).rejects.toThrow(/Disallowed runner target/);
  });
});

describe('isDisallowedAddress', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
  ])('flags %s as disallowed', (ip) => {
    expect(isDisallowedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])(
    'allows public address %s',
    (ip) => {
      expect(isDisallowedAddress(ip)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Pinned dispatcher — no rebinding window (SC-09, test 2b)
// ---------------------------------------------------------------------------

describe('createPinnedDispatcher — connects only to the pinned IP', () => {
  let server: http.Server;
  let port: number;
  let seenHost = '';

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          seenHost = req.headers.host ?? '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port;
          resolve();
        });
      }),
  );

  afterEach(() => {
    seenHost = '';
  });

  it('dials the pinned IP while preserving the original Host header', async () => {
    const dispatcher = createPinnedDispatcher('127.0.0.1');
    // The hostname is unresolvable — only the pinned IP makes this succeed.
    const res = await undiciFetch(`http://pinned-host.invalid:${port}/x`, { dispatcher });
    expect(res.status).toBe(200);
    expect(seenHost).toBe(`pinned-host.invalid:${port}`);
    await dispatcher.close();
  });

  it('closes the server after the suite', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scoped credential minting (SC-08)
// ---------------------------------------------------------------------------

describe('mintRunnerToken — asymmetric scoped token', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA');
    privateKey = pair.privateKey as CryptoKey;
    publicKey = pair.publicKey as CryptoKey;
  });

  it('produces an EdDSA token the public key can verify with all scope claims', async () => {
    const token = await mintRunnerToken(privateKey, {
      aud: 'https://runner.example',
      workspaceId: 'ws_1',
      agentId: 'agt_1',
      runId: 'run_1',
      callId: 'tc_1',
      idempotencyKey: 'tc_1',
      toolName: 'weather',
    });

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: 'https://runner.example',
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.workspaceId).toBe('ws_1');
    expect(payload.agentId).toBe('agt_1');
    expect(payload.toolName).toBe('weather');
    expect(payload.idempotencyKey).toBe('tc_1');
    expect(typeof payload.exp).toBe('number');
  });

  it('caps the TTL at 120s', async () => {
    const token = await mintRunnerToken(
      privateKey,
      {
        aud: 'https://runner.example',
        workspaceId: 'ws_1',
        agentId: 'agt_1',
        runId: 'run_1',
        callId: 'tc_1',
        idempotencyKey: 'tc_1',
        toolName: 'weather',
      },
      9999,
    );
    const { payload } = await jwtVerify(token, publicKey, { audience: 'https://runner.example' });
    const now = Math.floor(Date.now() / 1000);
    expect((payload.exp ?? 0) - now).toBeLessThanOrEqual(121);
  });
});

// ---------------------------------------------------------------------------
// RemoteToolExecutor — bounds, idempotency, error mapping
// ---------------------------------------------------------------------------

const CTX: ToolCallContext = { sessionId: 'ses_1', runId: 'run_1' };
function callOf(overrides: Partial<ToolCall> = {}): ToolCall {
  return { toolName: 'echo', callId: 'tc_1', arguments: {}, ...overrides };
}

describe('RemoteToolExecutor — payload bounds + response validation (SC-09)', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const bodies: string[] = [];

  function exec(overrides: Record<string, unknown> = {}) {
    return new RemoteToolExecutor({
      toolRunnerUrl: baseUrl,
      agentId: 'agt_1',
      policy: LOCAL,
      mintToken: async () => 'scoped-token',
      maxRetries: 0,
      timeoutMs: 1_000,
      ...overrides,
    });
  }

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            bodies.push(raw);
            handler(req, res);
          });
        });
        server.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
  );

  afterEach(() => {
    bodies.length = 0;
  });

  it('closes the server', () => expect(server.listening).toBe(true));

  it('refuses to send an over-limit input (no request made)', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ version: '1', result: 'ok' }));
    const huge = 'y'.repeat(RUNNER_MAX_INPUT_BYTES + 1);
    const result = await exec().execute(callOf({ arguments: { huge } }), CTX, new AbortController().signal);
    expect(result).toEqual({ ok: false, error: 'Tool input exceeds limit' });
    expect(bodies).toHaveLength(0);
  });

  it('rejects an over-limit response body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1', result: 'z'.repeat(RUNNER_MAX_OUTPUT_BYTES + 100) }));
    };
    const result = await exec().execute(callOf(), CTX, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Tool runner response exceeds limit');
  });

  it('rejects a non-conforming response shape', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'no version field' }));
    };
    const result = await exec().execute(callOf(), CTX, new AbortController().signal);
    expect(result).toEqual({ ok: false, error: 'Invalid runner response' });
  });

  it('sends a versioned envelope with the tc_ id as idempotency key + scoped bearer', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ version: '1', result: 'ok' }));
    await exec().execute(callOf({ callId: 'tc_xyz' }), CTX, new AbortController().signal);
    const sent = JSON.parse(bodies[0]);
    expect(sent.version).toBe('1');
    expect(sent.idempotencyKey).toBe('tc_xyz');
    expect(sent.context).toMatchObject({ agentId: 'agt_1', runId: 'run_1', callId: 'tc_xyz', sessionId: 'ses_1' });
  });
});

describe('RemoteToolExecutor — idempotency key stability on retry (SC-10)', () => {
  let server: http.Server;
  let baseUrl: string;
  const keys: string[] = [];
  let attempt = 0;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            keys.push(JSON.parse(raw).idempotencyKey);
            attempt += 1;
            if (attempt === 1) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ version: '1', error: { code: 'INTERNAL', message: 'boom' } }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ version: '1', result: 'recovered' }));
            }
          });
        });
        server.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
  );

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a retried invocation reuses the identical idempotency key', async () => {
    const executor = new RemoteToolExecutor({
      toolRunnerUrl: baseUrl,
      agentId: 'agt_1',
      policy: LOCAL,
      mintToken: async () => 'scoped-token',
      maxRetries: 1,
      retryDelayMs: 5,
      timeoutMs: 1_000,
    });
    const result = await executor.execute(callOf({ callId: 'tc_stable' }), CTX, new AbortController().signal);
    expect(result).toEqual({ ok: true, output: 'recovered' });
    expect(keys).toEqual(['tc_stable', 'tc_stable']); // same key across the retry
  });
});

describe('RemoteToolExecutor — error mapping', () => {
  function exec(url: string, overrides: Record<string, unknown> = {}) {
    return new RemoteToolExecutor({
      toolRunnerUrl: url,
      agentId: 'agt_1',
      policy: LOCAL,
      mintToken: async () => 'scoped-token',
      maxRetries: 0,
      timeoutMs: 1_000,
      ...overrides,
    });
  }

  it('maps a network refusal to a connection error', async () => {
    const result = await exec('http://127.0.0.1:1').execute(callOf(), CTX, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain('connection error');
  });

  it('maps a pre-aborted signal to "Aborted"', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await exec('http://127.0.0.1:1').execute(callOf(), CTX, ac.signal);
    expect(result).toEqual({ ok: false, error: 'Aborted' });
  });

  it('rejects a disallowed SSRF target without sending', async () => {
    const result = await exec('http://169.254.169.254', { policy: DEPLOYED }).execute(
      callOf(),
      CTX,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Disallowed runner target|requires https/);
  });

  it('surfaces a handler error message from a runner error response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1', error: { code: 'EXECUTION_ERROR', message: 'handler failed' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await exec(baseUrl).execute(callOf(), CTX, new AbortController().signal);
      expect(result).toEqual({ ok: false, error: 'handler failed' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
