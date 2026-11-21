/**
 * Setup without a token on a loopback development API (hardening 2026-11-20)
 * ============================================================================
 *
 * A web page the developer has open could claim the first administrator: a
 * `text/plain` POST needs no CORS preflight, and DNS rebinding sends the request
 * under the attacker's host name. The tokenless path now needs a JSON body and
 * loopback `Host` and `Origin`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({ db: {} }));
vi.mock("../../apps/api/src/lib/auth", () => ({ auth: {} }));

import { tokenlessSetupRefusal } from "../../apps/api/src/lib/first-run";

function request(headers: Record<string, string>, url = "http://127.0.0.1:3000/api/system/setup") {
  return new Request(url, { method: "POST", headers, body: "{}" });
}

describe("tokenlessSetupRefusal", () => {
  it("accepts the panel's own request (JSON, loopback host and origin)", () => {
    expect(
      tokenlessSetupRefusal(
        request({
          "content-type": "application/json",
          host: "127.0.0.1:3000",
          origin: "http://localhost:3001",
        })
      )
    ).toBeNull();
    // curl: no Origin
    expect(
      tokenlessSetupRefusal(
        request({ "content-type": "application/json; charset=utf-8", host: "localhost:3000" })
      )
    ).toBeNull();
    // An in-process request with no Host header: the URL decides
    expect(tokenlessSetupRefusal(request({ "content-type": "application/json" }))).toBeNull();
  });

  it("refuses a body that is not JSON (a simple cross-site POST)", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect(
        tokenlessSetupRefusal(request({ "content-type": type, host: "127.0.0.1:3000" }))
      ).toMatch(/application\/json/);
    }
    expect(tokenlessSetupRefusal(request({ host: "127.0.0.1:3000" }))).not.toBeNull();
  });

  it("refuses a non-loopback Host (DNS rebinding)", () => {
    expect(
      tokenlessSetupRefusal(
        request({ "content-type": "application/json", host: "rebind.attacker.example:3000" })
      )
    ).toMatch(/loopback host/);
    expect(
      tokenlessSetupRefusal(
        request({ "content-type": "application/json" }, "http://evil.example/api/system/setup")
      )
    ).toMatch(/loopback host/);
  });

  it("refuses a non-loopback or opaque Origin", () => {
    for (const origin of ["https://attacker.example", "null"]) {
      expect(
        tokenlessSetupRefusal(
          request({ "content-type": "application/json", host: "127.0.0.1:3000", origin })
        )
      ).toMatch(/loopback origin/);
    }
  });
});
