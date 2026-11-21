/**
 * Connections: public addresses only, a private host only when the operator names it
 * ============================================================================
 *
 * A connected client used the global `fetch`: a provider host whose DNS answered a
 * private address (the metadata service, another container) got the credential. Now
 * every call is pinned to checked addresses (`pinnedFetch`), and a self-hosted
 * service (an Odoo on the office network) is reachable only when its host is in
 * `CONNECTIONS_PRIVATE_HOSTS`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { allowedUrl } from "../../apps/api/src/lib/connections/client";
import {
  connectionFetch,
  isPrivateHostAllowed,
  privateHosts,
} from "../../apps/api/src/lib/connections/network";
import { providerProblem, registerProvider } from "../../apps/api/src/lib/connections/providers";
import { setResolverForTests, UnsafeTargetError } from "../../apps/api/src/lib/safe-fetch";

const saved = process.env.CONNECTIONS_PRIVATE_HOSTS;
afterEach(() => {
  if (saved === undefined) delete process.env.CONNECTIONS_PRIVATE_HOSTS;
  else process.env.CONNECTIONS_PRIVATE_HOSTS = saved;
  setResolverForTests(null);
});

const odoo = (apiHosts: string[]) => ({
  id: "odoo-test",
  name: "Odoo",
  authTypes: ["api_key" as const],
  scopeSets: { all: { description: "everything", scopes: [] } },
  apiHosts,
});

describe("CONNECTIONS_PRIVATE_HOSTS", () => {
  it("is an explicit list: names and IP literals, lower case, no garbage", () => {
    expect([
      ...privateHosts({ CONNECTIONS_PRIVATE_HOSTS: " Odoo.Internal , 10.0.4.12,,odoo" }),
    ]).toEqual(["odoo.internal", "10.0.4.12", "odoo"]);
    expect(privateHosts({ CONNECTIONS_PRIVATE_HOSTS: "*.internal, http://x" }).size).toBe(0);
    expect(privateHosts({}).size).toBe(0);
  });

  it("a provider may list a private host only when the operator named it", () => {
    delete process.env.CONNECTIONS_PRIVATE_HOSTS;
    expect(providerProblem(odoo(["odoo"]))).toMatch(/CONNECTIONS_PRIVATE_HOSTS/);
    process.env.CONNECTIONS_PRIVATE_HOSTS = "odoo";
    expect(providerProblem(odoo(["odoo"]))).toBeNull();
  });

  it("http is accepted only for a listed private host", () => {
    process.env.CONNECTIONS_PRIVATE_HOSTS = "odoo";
    registerProvider(odoo(["odoo", "api.example.com"]));
    expect(allowedUrl("odoo-test", "http://odoo:8069/json/2/res.partner")).toBe(true);
    expect(allowedUrl("odoo-test", "http://api.example.com/x")).toBe(false);
    expect(allowedUrl("odoo-test", "https://api.example.com/x")).toBe(true);
    expect(allowedUrl("odoo-test", "https://elsewhere.example.com/x")).toBe(false);
    expect(isPrivateHostAllowed("ODOO")).toBe(true);
  });
});

describe("the connected client's network", () => {
  it("refuses a provider host that resolves to a private address", async () => {
    delete process.env.CONNECTIONS_PRIVATE_HOSTS;
    setResolverForTests(async () => [{ address: "169.254.169.254", family: 4 }]);
    await expect(connectionFetch("https://api.example.com/x")).rejects.toBeInstanceOf(
      UnsafeTargetError
    );
  });

  it("lets a listed private host through to the address check (then connects to it)", async () => {
    process.env.CONNECTIONS_PRIVATE_HOSTS = "odoo";
    setResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    // Port 9 (discard) on loopback is closed: the error is the connection's, not the check's.
    const error = await connectionFetch("http://odoo:9/").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnsafeTargetError);
  });

  it("the client and the routes use it by default", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "..", "apps", "api", "src");
    expect(readFileSync(join(root, "lib/connections/client.ts"), "utf8")).toContain(
      "network: Fetch = connectionFetch"
    );
    expect(readFileSync(join(root, "lib/connections/index.ts"), "utf8")).toContain(
      "refreshTick(network: Fetch = connectionFetch"
    );
    expect(readFileSync(join(root, "routes/connections.ts"), "utf8")).toContain(
      "connectionsOperations(network: Fetch = connectionFetch)"
    );
  });
});
