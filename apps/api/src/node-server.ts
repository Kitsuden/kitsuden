/**
 * Kitsuden API under Node 22+
 * ============================================================================
 *
 * Bun is the main runtime (`bun run src/index.ts`: Bun uses the `export
 * default` of index.ts as the server, with WebSockets). This entry starts the
 * SAME Hono app with `@hono/node-server`, so as not to depend on Bun: if a
 * native module (sharp, argon2) or a Bun incompatibility appears in
 * production, the API can still run on Node.
 *
 *   bun build src/node-server.ts --target node --outdir dist-node \
 *     --external sharp --external @node-rs/argon2
 *   node dist-node/node-server.js
 *
 * (`pnpm --dir apps/api build:node` does it; CI starts it and requests /api/health.)
 *
 * Difference with Bun: WebSocket realtime (`/api/realtime`) is not there
 * (it responds 501); everything else —REST, MCP, SSE, the queue, the traces— is.
 */

import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";

import { listenHost } from "./lib/listen-host";

import { app } from "./index";

const port = Number(process.env.PORT) || 3001;
const hostname = listenHost();

const server = serve(
  {
    port,
    hostname,
    fetch: (req, env) => {
      if (new URL(req.url).pathname === "/api/realtime") {
        return new Response("Realtime WebSockets need the Bun runtime", { status: 501 });
      }
      // The same shape as Bun's `server.requestIP(req)`: lib/client-ip.ts.
      const s = (
        env as {
          incoming?: {
            socket?: { remoteAddress?: string; remoteFamily?: string; remotePort?: number };
          };
        }
      ).incoming?.socket;
      return app.fetch(req, {
        ip: {
          address: s?.remoteAddress ?? "",
          family: s?.remoteFamily ?? "",
          port: s?.remotePort ?? 0,
        },
        ...env,
      });
    },
  },
  (info: AddressInfo) => {
    console.log(
      `⚡ Kitsuden API (Node ${process.versions.node}) en http://${info.address}:${info.port}`
    );
  }
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close());
}
