# Behind a proxy you already run

`docker-compose.tls.yml` puts Caddy on ports 80 and 443 and gets the
certificates. If the server already has a reverse proxy (Traefik, Caddy, nginx,
Coolify), leave that file out and point your proxy at Kitsuden instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

Or once, in `.env`, so a plain `docker compose up -d` does it:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.public.yml
```

`docker-compose.public.yml` is everything the public install needs except Caddy:
the public URLs from `SITE_DOMAIN` and `KITSUDEN_DOMAIN`, `KITSUDEN_PUBLIC=true`
(the API refuses to start with a localhost URL or console mail), the website, and
the memory and log limits. Passwords and keys are generated on the first start,
as with Caddy.

## What your proxy must do

Two names, the same two Caddy serves (`docker/Caddyfile` is the reference):

| Name                      | Path       | Goes to                               | From the host    | From a container on the network |
| ------------------------- | ---------- | ------------------------------------- | ---------------- | ------------------------------- |
| `KITSUDEN_DOMAIN` (panel) | `/media/*` | the API (uploaded files)              | `127.0.0.1:3000` | `kitsuden_api:3000`             |
|                           | `/api/*`   | the panel's nginx, which adds the API | `127.0.0.1:3001` | `kitsuden_admin:8080`           |
|                           | the rest   | the panel                             | `127.0.0.1:3001` | `kitsuden_admin:8080`           |
| `SITE_DOMAIN` (website)   | everything | the website                           | `127.0.0.1:4321` | `kitsuden_web:4321`             |
| `www.SITE_DOMAIN`         | everything | a 308 redirect to `SITE_DOMAIN`       |                  |                                 |

The host ports listen on 127.0.0.1 only (`API_PORT`, `ADMIN_PORT`, `WEB_PORT`
change them). Nothing but your proxy should be published to the internet.

And, on both names:

- **TLS.** Kitsuden speaks plain HTTP behind the proxy.
- **Uploads up to 100 MB** on the panel name (the media library). nginx:
  `client_max_body_size 100m;`. Traefik has no limit by default.
- **WebSockets** on `/api/*` (realtime): pass `Upgrade` and `Connection`.
  Traefik and Caddy do it by themselves; nginx needs the two `proxy_set_header`
  lines in the example below.
- **These response headers**, which Caddy adds and the services do not:
  `Strict-Transport-Security: max-age=31536000`, `X-Frame-Options: SAMEORIGIN`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
  The panel's Content-Security-Policy comes from its own nginx; do not add a
  second one.
- **`X-Forwarded-Proto: https`** and the original `Host`.

## TRUSTED_PROXY_HOPS

The API takes the visitor's address from `X-Forwarded-For`, counting
`TRUSTED_PROXY_HOPS` entries from the right (`apps/api/src/lib/client-ip.ts`).
`docker-compose.public.yml` sets `2`: your proxy, then the panel's nginx. That is
right for every proxy in this page, as long as **your proxy is the first one**
the visitor reaches.

| In front of Kitsuden                                | `TRUSTED_PROXY_HOPS` |
| --------------------------------------------------- | -------------------- |
| your proxy (Traefik, Caddy, nginx, Coolify)         | `2` (the default)    |
| Cloudflare (proxied, orange cloud), then your proxy | `3`                  |
| another load balancer, then your proxy              | `3`                  |

A number higher than the real one lets a visitor choose the address the rate
limit sees; a lower one counts every visitor as your proxy.

The first proxy must **replace** an `X-Forwarded-For` that comes from the
internet, not append to it, because `/media/*` goes straight to the API (one hop
fewer). Caddy and Traefik replace it by default (Traefik: unless
`forwardedHeaders.insecure` or `trustedIPs` says otherwise). nginx appends with
`$proxy_add_x_forwarded_for`: on the first proxy, use `$remote_addr`, as below.

## Traefik (in Docker)

Traefik reaches the containers over a shared network. Create it once and put
this next to the compose files as `docker-compose.traefik.yml` (it is yours: it
is not in the repository). `websecure` and `letsencrypt` are the entry point and
certificate resolver names of your Traefik; change them to yours.

```yaml
networks:
  traefik:
    external: true # docker network create traefik

x-traefik: &on-traefik
  networks: [kitsuden_net_prod, traefik]

services:
  kitsuden_admin:
    <<: *on-traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.kitsuden-panel.rule=Host(`panel.example.com`)
      - traefik.http.routers.kitsuden-panel.entrypoints=websecure
      - traefik.http.routers.kitsuden-panel.tls.certresolver=letsencrypt
      - traefik.http.routers.kitsuden-panel.middlewares=kitsuden-headers
      - traefik.http.services.kitsuden-panel.loadbalancer.server.port=8080
      - traefik.http.middlewares.kitsuden-headers.headers.stsSeconds=31536000
      - traefik.http.middlewares.kitsuden-headers.headers.customFrameOptionsValue=SAMEORIGIN
      - traefik.http.middlewares.kitsuden-headers.headers.contentTypeNosniff=true
      - traefik.http.middlewares.kitsuden-headers.headers.referrerPolicy=strict-origin-when-cross-origin

  kitsuden_api:
    <<: *on-traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.kitsuden-media.rule=Host(`panel.example.com`) && PathPrefix(`/media/`)
      - traefik.http.routers.kitsuden-media.entrypoints=websecure
      - traefik.http.routers.kitsuden-media.tls.certresolver=letsencrypt
      - traefik.http.routers.kitsuden-media.middlewares=kitsuden-headers
      - traefik.http.services.kitsuden-media.loadbalancer.server.port=3000

  kitsuden_web:
    <<: *on-traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.kitsuden-site.rule=Host(`example.com`)
      - traefik.http.routers.kitsuden-site.entrypoints=websecure
      - traefik.http.routers.kitsuden-site.tls.certresolver=letsencrypt
      - traefik.http.routers.kitsuden-site.middlewares=kitsuden-headers
      - traefik.http.services.kitsuden-site.loadbalancer.server.port=4321
      - traefik.http.routers.kitsuden-www.rule=Host(`www.example.com`)
      - traefik.http.routers.kitsuden-www.entrypoints=websecure
      - traefik.http.routers.kitsuden-www.tls.certresolver=letsencrypt
      - traefik.http.routers.kitsuden-www.middlewares=kitsuden-www
      - traefik.http.middlewares.kitsuden-www.redirectregex.regex=^https://www\.example\.com/(.*)
      - traefik.http.middlewares.kitsuden-www.redirectregex.replacement=https://example.com/$${1}
      - traefik.http.middlewares.kitsuden-www.redirectregex.permanent=true
```

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.public.yml:docker-compose.traefik.yml
```

Traefik picks the longer rule first, so `/media/` reaches the API and the rest
of the panel name the panel. For uploads over Traefik's own limits, if you set
any, allow 100 MB on `kitsuden-panel`.

## Caddy or nginx on the host

Caddy on the host: `docker/Caddyfile` with the upstreams changed to the host
ports (`kitsuden_api:3000` → `127.0.0.1:3000`, `kitsuden_admin:8080` →
`127.0.0.1:3001`, `kitsuden_web:4321` → `127.0.0.1:4321`).

nginx on the host (certificates from certbot or your own):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 443 ssl http2;
    server_name panel.example.com;
    # ssl_certificate …; ssl_certificate_key …;
    client_max_body_size 100m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    # The first proxy REPLACES the header: see TRUSTED_PROXY_HOPS above
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_http_version 1.1;

    location /media/ { proxy_pass http://127.0.0.1:3000; }
    location /       { proxy_pass http://127.0.0.1:3001; }
}

server {
    listen 443 ssl http2;
    server_name example.com;
    # ssl_certificate …; ssl_certificate_key …;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;

    location / { proxy_pass http://127.0.0.1:4321; }
}

server {
    listen 443 ssl http2;
    server_name www.example.com;
    return 308 https://example.com$request_uri;
}
```

## Coolify

Coolify deploys one compose file and puts its own proxy (Traefik or Caddy) in
front, with a domain field per service. Give it the merged file, with the
variables left as they are:

```bash
docker compose -f docker-compose.yml -f docker-compose.public.yml \
  config --no-interpolate > docker-compose.coolify.yml
```

Then, in Coolify:

- the panel domain on `kitsuden_admin`, port `8080`;
- the same domain with the path `/media` on `kitsuden_api`, port `3000`;
- the site domain on `kitsuden_web`, port `4321`;
- `SITE_DOMAIN` and `KITSUDEN_DOMAIN` in the environment, plus a mail transport
  (`RESEND_API_KEY` or `SMTP_*`) and `MAIL_FROM`. Nothing else: the secrets are
  generated.

Coolify's proxy is the first one, so `TRUSTED_PROXY_HOPS` stays `2`.

**Not tested** against a running Coolify: the merged file and the routes above
follow from the compose files and Coolify's documented compose support. Check
`curl -sI https://panel.example.com/api/version` and an upload from the media
library after the first deploy.

## Checking it

```bash
curl -sI https://panel.example.com/                # 200, with the four headers
curl -s  https://panel.example.com/api/version     # the API, through the panel's nginx
curl -sI https://example.com/                      # the website
curl -sI https://www.example.com/                  # 308 to https://example.com/
```

In the panel, upload an image bigger than 1 MB to the media library and open it:
that exercises the body limit and `/media/*`.
