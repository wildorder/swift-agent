# @swiftagent/react

React hooks and components for building Swift Agent chat UIs. It wraps the Swift Agent streaming protocol in idiomatic React state so you can render live agent conversations with minimal wiring. Requires React 18 or 19 (declared as a peer dependency).

## Install

`@swiftagent/*` packages are published to the org's private GitHub Packages registry, not public npm. Add the scope mapping to your `.npmrc` (already committed at the repo root here) and authenticate with a token that has `read:packages`:

```ini
@swiftagent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PKG_TOKEN}
```

```sh
pnpm add @swiftagent/react
```
