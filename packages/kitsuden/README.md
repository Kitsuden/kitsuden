# kitsuden

Kitsuden in one install: the typed SDK and the `kitsuden` command.

Kitsuden is a self-hosted backend for AI agents, on Postgres with row-level
security and human approval. This package does not contain the server: run that
from the Docker images (`npm create kitsuden@beta`) or from the repository.

```bash
npm install kitsuden@beta
```

## The SDK

`kitsuden` re-exports [`@kitsuden/sdk`](https://www.npmjs.com/package/@kitsuden/sdk):
the same module, not a copy, so both names can be mixed in one project.

```ts
import { createKitsuden } from "kitsuden";

const kitsuden = createKitsuden({
  url: process.env.KITSUDEN_API_URL!,
  token: process.env.KITSUDEN_API_TOKEN!,
});
```

The SDK's subpaths (`/realtime`, `/rpc`, `/toon-protocol`, `/openapi.json`) are
imported from `@kitsuden/sdk` directly.

## The command

`npx kitsuden …` runs [`@kitsuden/cli`](https://www.npmjs.com/package/@kitsuden/cli)
with the same arguments:

```bash
npx kitsuden --help
npx kitsuden kon list --available
```

Install either `kitsuden` or `@kitsuden/cli` globally, not both: they declare the
same `kitsuden` command.

## Related packages

| Package                | What it is                                          |
| ---------------------- | --------------------------------------------------- |
| `create-kitsuden`      | `npm create kitsuden`: a new project                |
| `@kitsuden/sdk`        | the typed client                                    |
| `@kitsuden/cli`        | the `kitsuden` command                              |
| `@kitsuden/mcp-server` | the MCP server for agents (runs on Bun)             |
| `@kitsuden/shared`     | types and Zod schemas shared by the API and clients |
| `@kitsuden/codegen`    | frontend code generation for collections            |

Server images: `ghcr.io/kitsuden/kitsuden/api` and `ghcr.io/kitsuden/kitsuden/admin`.

## License

MIT
