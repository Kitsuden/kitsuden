/**
 * The API listens on a configurable address (`HOST`): 0.0.0.0 by default in
 * production, 127.0.0.1 otherwise (security review 2026-11-03: a development API
 * on 0.0.0.0 had setup and sign-up open to the whole network).
 *
 * Without `hostname` in the bun server, on Windows it only answered on
 * `localhost` (::1) and `127.0.0.1` gave connection refused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  listenHost,
  listensBeyondLoopback,
} from "../../apps/api/src/lib/listen-host";
import { signUpClosed } from "../../apps/api/src/lib/signup-mode";

describe("listenHost", () => {
  it("by default all IPv4 interfaces in production, loopback otherwise", () => {
    expect(listenHost({ NODE_ENV: "production" })).toBe("0.0.0.0");
    expect(listenHost({ NODE_ENV: "production", HOST: "  " })).toBe("0.0.0.0");
    expect(listenHost({})).toBe("127.0.0.1");
    expect(listenHost({ NODE_ENV: "development" })).toBe("127.0.0.1");
  });

  it("which addresses count as this machine only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.2",
      "example.com",
      "127.0.0.1.nip.io",
    ]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
    expect(listensBeyondLoopback({})).toBe(false);
    expect(listensBeyondLoopback({ HOST: "0.0.0.0" })).toBe(true);
    expect(listensBeyondLoopback({ NODE_ENV: "production" })).toBe(true);
  });

  it("beyond loopback, sign-up is closed unless KITSUDEN_SIGNUP=open", () => {
    expect(signUpClosed({ NODE_ENV: "development" })).toBe(false);
    expect(signUpClosed({ NODE_ENV: "development", HOST: "0.0.0.0" })).toBe(true);
    expect(signUpClosed({ NODE_ENV: "development", HOST: "::" })).toBe(true);
    expect(signUpClosed({ NODE_ENV: "development", KITSUDEN_PUBLIC: "true" })).toBe(true);
    expect(signUpClosed({ HOST: "0.0.0.0", KITSUDEN_SIGNUP: "open" })).toBe(false);
  });

  it("HOST rules", () => {
    expect(listenHost({ HOST: "127.0.0.1" })).toBe("127.0.0.1");
    expect(listenHost({ HOST: "::" })).toBe("::");
  });

  it("the API server uses it (and not just the port)", () => {
    const index = readFileSync(resolve(__dirname, "../../apps/api/src/index.ts"), "utf8");
    expect(index).toMatch(/const hostname = listenHost\(\);/);
    expect(index).toMatch(/export default \{\s*port,\s*hostname,/);
  });

  it("the image sets HOST=0.0.0.0 and the compose still publishes only on 127.0.0.1", () => {
    const docker = readFileSync(resolve(__dirname, "../../docker/Dockerfile.prod"), "utf8");
    expect(docker).toMatch(/^ENV HOST=0\.0\.0\.0\s*$/m);
    const compose = readFileSync(resolve(__dirname, "../../docker-compose.yml"), "utf8");
    expect(compose).toContain('"${BIND_ADDRESS:-127.0.0.1}:${API_PORT:-3000}:3000"');
  });
});
