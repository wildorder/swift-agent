import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@swiftagent/shared', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('shared');
  });
});
