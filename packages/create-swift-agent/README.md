# create-swift-agent

Scaffold a runnable [Swift Agent](https://github.com/wildorder/swift-agent)
project in about a minute:

```bash
npx create-swift-agent my-agent
```

The generated project contains:

- **`backend/`** — an SDK backend (`@swiftagent/sdk`) with one agent, one
  Zod-schema tool, and a `GET /api/session` route.
- **`frontend/`** — a Vite + React 19 chat UI using `useAgentChat` from
  `@swiftagent/react`.
- **`docker-compose.yml`** — a local development stack (Postgres, Redis, a
  single Swift Agent server, a one-shot dev-key bootstrap, and the backend) that
  completes a real streaming tool round trip with **no model provider key**,
  via the server's deterministic local fixture model.
- **`.env.example` / `.env`** — environment surface; your provider key (if you
  supply one) is written into `.env` only, which is gitignored.

## Usage

```
create-swift-agent [name] [options]

  --name <name>          project name (also accepted as the first positional)
  --provider <id>        model provider: anthropic | openai | google (default: anthropic)
  --provider-key <key>   provider API key — written into the generated .env only
  --yes                  non-interactive: accept defaults, never prompt
  --no-install           skip npm install in backend/ and frontend/
  --help                 show this help
```

Run without flags on a terminal and it prompts for the project name, provider,
and (optionally) an API key. With `--yes` — or when stdin is not a TTY — it
never prompts: the name is required, the provider defaults to `anthropic`.

## After generating

```bash
cd my-agent
docker compose up -d        # full local stack; mints a dev API key on first run
cd frontend && npm run dev  # open the printed URL and chat
```

See the generated project's `README.md` for details, including how to switch
from the zero-key fixture model to your real provider model.

## License

Apache-2.0. This package is the only unscoped package in the Swift Agent
monorepo — `npx create-swift-agent` requires an unscoped bin name.
