/**
 * WS-43 · `pnpm smoke:local` entry point.
 *
 * Assigns the local-compose defaults as process.env FALLBACKS (explicit env
 * still wins), then runs the shared smoke module. The defaults live here — not
 * as inline env prefixes in package.json — because POSIX-style `VAR=x cmd`
 * prefixes do not work in Windows shells.
 */
process.env.SMOKE_BASE_URL ??= 'http://localhost:3000';
process.env.SMOKE_AGENT_NAME ??= 'local-dev';
process.env.REQUIRE_TOOLS ??= '1';
process.env.SMOKE_API_KEY_FILE ??= './.swiftagent-local/dev-api-key';

// Dynamic import so the env assignments above land before the smoke module
// reads process.env at module scope.
await import('./realtime-smoke.js');
