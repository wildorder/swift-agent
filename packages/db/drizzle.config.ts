import { defineConfig } from 'drizzle-kit';

// NOTE: schema points at the COMPILED output (`dist/schema/*.js`), not `src`.
// drizzle-kit 0.30 loads schema via CJS require and cannot resolve the ESM
// `.js` import specifiers used across the `src/schema/*.ts` modules, so we
// build first and generate from JS. The `db:generate` script runs `tsc`
// beforehand to keep this deterministic.
export default defineConfig({
  schema: './dist/schema/*.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL']!,
  },
});
