import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { generateProject } from '../generate.js';

/**
 * SC-12 · The scaffold-generated compose file is single-instance by
 * construction: exactly one server service, no replica configuration. This is
 * a LOCAL development artifact explicitly outside the managed-surface family —
 * this test is its required assertion.
 */

const TEMPLATES_DIR = join(fileURLToPath(new URL('../..', import.meta.url)), 'templates');

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: unknown;
  deploy?: unknown;
  replicas?: unknown;
  scale?: unknown;
  network_mode?: string;
  ports?: string[];
  environment?: Record<string, string>;
  [key: string]: unknown;
}

let targetDir: string;
let services: Record<string, ComposeService>;

beforeAll(() => {
  targetDir = mkdtempSync(join(tmpdir(), 'csa-compose-'));
  const { projectDir } = generateProject({
    name: 'compose-check',
    provider: 'anthropic',
    targetDir,
    templatesDir: TEMPLATES_DIR,
  });
  const doc = parse(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')) as {
    services: Record<string, ComposeService>;
  };
  services = doc.services;
});

afterAll(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

/** A service RUNS the server when it uses the server image without a command override. */
function isServerService([, svc]: [string, ComposeService]): boolean {
  const image = typeof svc.image === 'string' ? svc.image : '';
  return image.includes('swift-agent') && svc.command === undefined;
}

describe('generated docker-compose shape (SC-12)', () => {
  it('defines exactly one server service', () => {
    const serverServices = Object.entries(services).filter(isServerService);
    expect(serverServices.map(([name]) => name)).toEqual(['swift-agent']);
  });

  it('carries no replica configuration on any service', () => {
    for (const [name, svc] of Object.entries(services)) {
      expect(svc.deploy, `${name} must not use deploy:`).toBeUndefined();
      expect(svc.replicas, `${name} must not use replicas:`).toBeUndefined();
      expect(svc.scale, `${name} must not use scale:`).toBeUndefined();
    }
  });

  it('has no second server-like listener: only swift-agent publishes port 3000', () => {
    const publishers = Object.entries(services).filter(([, svc]) =>
      (svc.ports ?? []).some((p) => String(p).includes('3000')),
    );
    expect(publishers.map(([name]) => name)).toEqual(['swift-agent']);
  });

  it('matches the WS-43 single-listener contract', () => {
    const server = services['swift-agent'];
    if (!server) throw new Error('swift-agent service missing');
    expect(server.ports).toContain('3000:3000');
    expect(server.environment?.API_PORT).toBe('3000');
    // PUBLIC_WEBSOCKET_URL points at the single published port with the
    // canonical /v1/stream path — handed to clients verbatim.
    expect(server.environment?.PUBLIC_WEBSOCKET_URL).toBe('ws://localhost:3000/v1/stream');
    expect(server.environment?.AUTO_MIGRATE).toBe('true');
    expect(server.environment?.LOCAL_FIXTURE_PROVIDER).toBe('true');
  });

  it('runs the bootstrap as a one-shot and the backend inside the server netns', () => {
    const bootstrap = services['bootstrap'];
    const backend = services['backend'];
    if (!bootstrap || !backend) throw new Error('bootstrap/backend service missing');
    // bootstrap: same image but a one-shot provisioning command — not a server.
    expect(JSON.stringify(bootstrap.command)).toContain('provision-local');
    // backend: no published ports of its own; shares the server's namespace so
    // the tool runner is loopback-reachable (never a second listener service).
    expect(backend.network_mode).toBe('service:swift-agent');
    expect(backend.ports).toBeUndefined();
  });
});
