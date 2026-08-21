import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectSnapshot } from '../drift-check.js';
import { loadSnapshot } from '../snapshot.js';

/**
 * Regression guard: drizzle-kit serializes a column default in its NATIVE JSON
 * type — a string for text/quoted SQL, but a raw boolean for
 * `boolean(...).default(false)` and a number for numeric defaults. A
 * string-only `default` schema crashed loadSnapshot (and therefore db:check +
 * the migrate preflight) with exit 2 on any boolean/numeric default. The
 * loader must accept all three scalar shapes and coerce to string.
 */
describe('loadSnapshot — column default scalar coercion', () => {
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'sa-snap-'));
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const snapshot = {
      version: '7',
      dialect: 'postgresql',
      tables: {
        'public.widgets': {
          name: 'widgets',
          schema: '',
          columns: {
            id: { name: 'id', type: 'text', primaryKey: true, notNull: true },
            // boolean default — the shape that previously crashed the parser
            enabled: { name: 'enabled', type: 'boolean', notNull: false, default: false },
            // numeric default — also non-string
            retries: { name: 'retries', type: 'integer', notNull: false, default: 3 },
            // string default — must still work
            label: { name: 'label', type: 'text', notNull: false, default: "'unnamed'" },
          },
          indexes: {},
          foreignKeys: {},
          compositePrimaryKeys: {},
          uniqueConstraints: {},
        },
      },
      enums: {},
    };
    writeFileSync(join(folder, 'meta', '0000_snapshot.json'), JSON.stringify(snapshot));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('parses boolean and numeric defaults without throwing', () => {
    expect(() => loadSnapshot(folder, 0)).not.toThrow();
  });

  it('coerces each default to a normalized string in the canonical projection', () => {
    const projected = projectSnapshot(loadSnapshot(folder, 0));
    const cols = projected.tables['widgets']?.columns;
    expect(cols?.['enabled']?.default).toBe('false');
    expect(cols?.['retries']?.default).toBe('3');
    expect(cols?.['label']?.default).toBe('unnamed');
    expect(cols?.['id']?.default).toBeNull();
  });
});
