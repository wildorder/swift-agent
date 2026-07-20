---
"@swiftagent/shared": minor
"@swiftagent/sdk": minor
"@swiftagent/react": minor
"@swiftagent/api": minor
---

Add protocol versioning & compatibility policy (WS-37). `@swiftagent/shared` now
exports `API_PROTOCOL_VERSION`, `SDK_MIN_SERVER_PROTOCOL`, `PROTOCOL_HEADER`,
`PROTOCOL`, and the pure `assertProtocolCompatible(...)`, plus a new
`INCOMPATIBLE_VERSION` error code (HTTP 409). The server advertises its
control-plane protocol version via an additive `x-swiftagent-protocol` response
header; the SDK asserts compatibility at agent registration, and the react
connect path asserts it before opening the WebSocket (surfacing
`CreateSessionResult.serverProtocolVersion`). All additions are backward
compatible and fail open against a header-less legacy server.
