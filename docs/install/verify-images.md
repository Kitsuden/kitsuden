# Verifying and pinning container images

## Third-party images are pinned by digest

Every image Kitsuden pulls from someone else (`pgvector/pgvector`,
`valkey/valkey`, `chrislusf/seaweedfs`, `caddy`, `edoburu/pgbouncer`, and the
`oven/bun`, `node` and `nginxinc/nginx-unprivileged` bases of the Dockerfiles)
is written as `name:tag@sha256:<digest>`. A tag can be moved by whoever controls
the upstream repository; a digest cannot. The tag stays for humans, and
Dependabot updates both together.

`tests/unit/images-pinned-by-digest.test.ts` fails if a compose file or a
Dockerfile gains a third-party image without a digest.

## Kitsuden's own images

The API, panel and MCP images published to
`ghcr.io/kitsuden/kitsuden/*` carry:

- an SBOM and SLSA provenance (`provenance: mode=max`);
- a GitHub build-provenance attestation (Sigstore);
- a keyless **cosign** signature on the digest, made by the release workflow
  (`.github/workflows/docker-publish.yml`).

Verify before you deploy:

```bash
# With the GitHub CLI
gh attestation verify oci://ghcr.io/kitsuden/kitsuden/api:<version> -R Kitsuden/kitsuden

# With cosign
cosign verify ghcr.io/kitsuden/kitsuden/api@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/Kitsuden/kitsuden/\.github/workflows/docker-publish\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Then pin what you verified. The compose file reads the image names from the
environment, so put the digest there:

```bash
KITSUDEN_API_IMAGE=ghcr.io/kitsuden/kitsuden/api@sha256:<digest>
KITSUDEN_ADMIN_IMAGE=ghcr.io/kitsuden/kitsuden/admin@sha256:<digest>
```

Get the digest of a tag without pulling it:

```bash
docker buildx imagetools inspect ghcr.io/kitsuden/kitsuden/api:<version>
```

An image you build yourself (`docker compose build`) has no signature: these
checks are for images pulled from the registry.
