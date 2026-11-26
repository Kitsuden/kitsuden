# create-kitsuden

`npm create kitsuden`: a new [Kitsuden](https://github.com/Kitsuden/kitsuden)
project, with its secrets generated.

```bash
npm create kitsuden@beta my-app
cd my-app
docker compose up -d
```

Two modes:

- **docker** (default): a `docker-compose.yml` and a `.env` for the published
  images (`ghcr.io/kitsuden/kitsuden/api` and `admin`, tag `0.9.0-beta` unless you
  pass `--image-tag`). Nothing is downloaded to scaffold: the templates travel
  inside this package.
- **local**: a checkout of the source, to run with Bun and pnpm
  (`--mode local`; needs `git`, or `--source <path>` to an existing checkout).

```
npm create kitsuden@beta [folder] -- [options]

  --mode <docker|local>   docker (default) or local
  --instance <name>       prefix of containers and volumes (docker)
  --registry <prefix>     image registry (default ghcr.io/kitsuden/kitsuden)
  --image-tag <tag>       image tag (default: this package's version)
  --source <url|path>     local mode: where to clone from
  --ref <branch|tag>      local mode: what to clone
  --api-port, --admin-port, --db-port, --valkey-port <n>
  --skip-checks           do not look for free ports or an install with the same name
  -y, --yes               ask nothing (folder defaults to kitsuden-app)
  -h, --help
```

The `.env` it writes holds the generated passwords: keep it out of version control.

Requires Node.js 20+, and Docker for the docker mode. MIT.
