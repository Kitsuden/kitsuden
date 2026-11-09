# syntax=docker/dockerfile:1.7-labs
# ^ needed for `COPY --parents`.
# ===================================================================
# Kitsuden MCP Server Docker Image (Standalone)
# Build: docker build -f docker/mcp/Dockerfile -t ghcr.io/kitsuden/kitsuden/mcp:latest .
#
# The server calls the API with its token and listens inside the container on
# 0.0.0.0, so it refuses to start without MCP_AUTH_TOKEN, the bearer token
# clients must send:
#   docker run -p 127.0.0.1:3002:3002 -e KITSUDEN_API_URL=... \
#     -e KITSUDEN_API_TOKEN=... -e MCP_AUTH_TOKEN=... <image>
# ===================================================================

FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# Install pnpm (project uses pnpm, not bun for package management)
RUN apk add --no-cache nodejs npm
RUN npm install -g pnpm@9.15.4

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Every workspace manifest: the lockfile and the root package.json refer to them,
# so a partial list makes --frozen-lockfile fail.
COPY --parents apps/*/package.json packages/*/package.json packages/*/*/package.json ./

# Install dependencies
#
# --frozen-lockfile WITHOUT fallback: the image carries no versions nobody reviewed.
#
# --ignore-scripts for the same reason as in Dockerfile.prod: only manifests are here
# and the `prepare` of @kitsuden/shared (scripts/build.ts) does not exist yet. Shared
# is compiled by hand below, and the MCP server has no native dependencies (MCP
# SDK, hono, zod), so the `pnpm rebuild` from Dockerfile.prod is not needed.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY packages/mcp-server ./packages/mcp-server
COPY packages/shared ./packages/shared
COPY packages/sdk ./packages/sdk

# Build shared first, then MCP server
RUN pnpm --filter @kitsuden/shared build
WORKDIR /app/packages/mcp-server
RUN bun run build

# esbuild ships a Go binary (one per version) that only the build uses. Removed
# here, before node_modules is copied to the runtime image: Trivy flags its old Go
# standard library, and nothing at runtime runs it.
RUN rm -rf /app/node_modules/.pnpm/@esbuild+*

# Production stage
FROM oven/bun:1.3.14-alpine AS production
WORKDIR /app

# `apk upgrade`: Alpine security fixes the base image lags behind (Trivy in CI)
RUN apk upgrade --no-cache && apk add --no-cache curl

# Copy built files and dependencies
COPY --from=base /app/packages/mcp-server/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/mcp-server/package.json ./

# No root, like the API in Dockerfile.prod: `bun`
# (uid 1000) ships with the base image. The server does not write to disk, so
# the code copied above stays root-owned and read-only for it.
USER bun

ENV NODE_ENV=production
ENV PORT=3002
ENV KITSUDEN_API_URL=http://localhost:3000
ENV MCP_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3002/health || exit 1

EXPOSE 3002

CMD ["bun", "run", "dist/standalone.js"]
