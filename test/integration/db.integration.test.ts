import { describe, it, expect } from 'vitest';
import postgres from 'postgres';

describe('Testcontainers Postgres', () => {
  it('connects to the Postgres container and runs a query', async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    expect(databaseUrl).toBeDefined();

    const sql = postgres(databaseUrl!);

    try {
      const result = await sql`SELECT 1 as value`;
      expect(result[0]?.value).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
