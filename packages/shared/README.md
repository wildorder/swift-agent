# @swiftagent/shared

Shared types, Zod schemas, ID helpers, and the Redis client used across Swift Agent packages. It is the source of truth for the `ChatEvent` union, the prefixed-ID helpers, and the `ENV_KEYS` env-var contract, and is pulled in transitively by `@swiftagent/sdk` and `@swiftagent/react`. The Redis client is available from the `@swiftagent/shared/redis` subpath.

## Install

`@swiftagent/*` packages are published to the org's private GitHub Packages registry, not public npm. Add the scope mapping to your `.npmrc` (already committed at the repo root here) and authenticate with a token that has `read:packages`:

```ini
@swiftagent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}
```

```sh
pnpm add @swiftagent/shared
```
