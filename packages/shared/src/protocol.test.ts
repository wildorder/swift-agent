import { describe, it, expect } from 'vitest';
import {
  assertProtocolCompatible,
  API_PROTOCOL_VERSION,
  SDK_MIN_SERVER_PROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL,
  RUNNER_PROTOCOL_VERSION,
  SwiftAgentErrorCode,
  isSwiftAgentError,
} from './index.js';

describe('assertProtocolCompatible', () => {
  it('compatible version passes (default local + explicit-match override)', () => {
    expect(() => assertProtocolCompatible('1')).not.toThrow();
    expect(() =>
      assertProtocolCompatible('2', { min: '1', current: '2' }),
    ).not.toThrow();
    // Within a supported range (min < remote < current) also passes.
    expect(() =>
      assertProtocolCompatible('2', { min: '1', current: '3' }),
    ).not.toThrow();
  });

  it('server too old throws an actionable INCOMPATIBLE_VERSION error', () => {
    let caught: unknown;
    try {
      assertProtocolCompatible('1', { min: '2', current: '2' });
    } catch (e) {
      caught = e;
    }
    expect(isSwiftAgentError(caught)).toBe(true);
    if (!isSwiftAgentError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe(SwiftAgentErrorCode.INCOMPATIBLE_VERSION);
    expect(caught.code).toBe('INCOMPATIBLE_VERSION');
    expect(caught.statusCode).toBe(409);
    // Names both the server version and the SDK current, tells you to upgrade the server.
    expect(caught.message).toContain('1');
    expect(caught.message).toContain('2');
    expect(caught.message.toLowerCase()).toContain('server');
  });

  it('server too new throws and instructs upgrading the SDK', () => {
    let caught: unknown;
    try {
      assertProtocolCompatible('3', { min: '1', current: '2' });
    } catch (e) {
      caught = e;
    }
    expect(isSwiftAgentError(caught)).toBe(true);
    if (!isSwiftAgentError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('INCOMPATIBLE_VERSION');
    expect(caught.message).toContain('3');
    expect(caught.message).toContain('2');
    expect(caught.message).toContain('@swiftagent/sdk');
  });

  it('unparseable version throws and names the bad value', () => {
    let caught: unknown;
    try {
      assertProtocolCompatible('banana');
    } catch (e) {
      caught = e;
    }
    expect(isSwiftAgentError(caught)).toBe(true);
    if (!isSwiftAgentError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe('INCOMPATIBLE_VERSION');
    expect(caught.message).toContain('banana');
  });

  it('absent/empty version fails open (legacy-server tolerance)', () => {
    expect(() => assertProtocolCompatible(undefined)).not.toThrow();
    expect(() => assertProtocolCompatible(null)).not.toThrow();
    expect(() => assertProtocolCompatible('')).not.toThrow();
  });
});

describe('protocol constants', () => {
  it('expose the SDK/server contract versions', () => {
    expect(API_PROTOCOL_VERSION).toBe('1');
    expect(SDK_MIN_SERVER_PROTOCOL).toBe('1');
    expect(PROTOCOL_HEADER).toBe('x-swiftagent-protocol');
  });

  it('PROTOCOL bundles the constants and re-exports the runner version', () => {
    expect(PROTOCOL.api).toBe(API_PROTOCOL_VERSION);
    expect(PROTOCOL.sdkMinServer).toBe(SDK_MIN_SERVER_PROTOCOL);
    expect(PROTOCOL.header).toBe(PROTOCOL_HEADER);
    expect(PROTOCOL.runner).toBe(RUNNER_PROTOCOL_VERSION);
  });
});
