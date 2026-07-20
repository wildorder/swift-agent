# @swiftagent/sdk

The TypeScript SDK for building, defining, and running Swift Agent agents. It exposes the agent-definition helpers, the streaming chat loop, and the tool/model primitives used to embed Swift Agent into your own services.

## Install

`@swiftagent/*` packages are published to the org's private GitHub Packages registry, not public npm. Add the scope mapping to your `.npmrc` (already committed at the repo root here) and authenticate with a token that has `read:packages`:

```ini
@swiftagent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}
```

```sh
pnpm add @swiftagent/sdk
```
