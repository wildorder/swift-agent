import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = ReturnType<typeof createDbClient>['db'];

export interface DbClient {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: ReturnType<typeof postgres>;
  close: () => Promise<void>;
}

export function createDbClient(connectionString: string): DbClient {
  const pool = postgres(connectionString);
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
