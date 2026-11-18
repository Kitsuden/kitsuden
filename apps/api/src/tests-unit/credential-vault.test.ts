/**
 * Credential vault (lib/credential-vault.ts): what a binding may say, where the
 * value goes, and that it never comes back to the code.
 */

import { describe, expect, test } from "bun:test";

import {
  credentialsProblem,
  injectCredentials,
  parseCredentialBindings,
  placeholderCredentials,
  redact,
  VaultError,
  type VaultCredential,
} from "../lib/credential-vault";

const stripe: VaultCredential = {
  secret: "STRIPE_KEY",
  host: "api.stripe.com",
  header: "Authorization",
  format: "Bearer {secret}",
  value: "vault-fixture-value-0001",
};

describe("bindings", () => {
  test("defaults: Authorization + Bearer", () => {
    expect(parseCredentialBindings([{ secret: "K", host: "api.a.com" }])).toEqual([
      { secret: "K", host: "api.a.com", header: "Authorization", format: "Bearer {secret}" },
    ]);
  });

  test("refuses wide hosts, framing headers, formats without {secret}, unknown keys", () => {
    expect(credentialsProblem([{ secret: "K", host: "*" }])).toContain("host");
    expect(credentialsProblem([{ secret: "K", host: "10.0.0.0/8" }])).toContain("host");
    expect(credentialsProblem([{ secret: "K", host: "https://a.com" }])).toContain("host");
    expect(credentialsProblem([{ secret: "K", host: "a.com", header: "Host" }])).toContain(
      "cannot be"
    );
    expect(credentialsProblem([{ secret: "K", host: "a.com", header: "Cookie" }])).toContain(
      "cannot be"
    );
    expect(credentialsProblem([{ secret: "K", host: "a.com", format: "Basic" }])).toContain(
      "{secret}"
    );
    expect(
      credentialsProblem([{ secret: "K", host: "a.com", format: "{secret}{secret}" }])
    ).toContain("once");
    expect(credentialsProblem([{ secret: "K", host: "a.com", url: "x" }])).toContain("unknown key");
    expect(credentialsProblem([{ secret: "bad key", host: "a.com" }])).toContain("secret");
    expect(credentialsProblem("K")).toContain("list");
    expect(credentialsProblem(undefined)).toBeNull();
  });
});

describe("injection", () => {
  test("only to the bound host, only over https, replacing the code's own header", () => {
    const headers: Record<string, string> = { authorization: "Bearer stolen?", accept: "json" };
    const values = injectCredentials(
      [stripe],
      new URL("https://api.stripe.com/v1/charges"),
      headers
    );
    expect(headers).toEqual({ accept: "json", Authorization: "Bearer vault-fixture-value-0001" });
    expect(values).toContain("vault-fixture-value-0001");

    const other: Record<string, string> = {};
    expect(injectCredentials([stripe], new URL("https://evil.example/"), other)).toEqual([]);
    expect(other).toEqual({});

    expect(() => injectCredentials([stripe], new URL("http://api.stripe.com/"), {})).toThrow(
      VaultError
    );
  });

  test("a wildcard binding covers subdomains only", () => {
    const wild = { ...stripe, host: "*.stripe.com" };
    const h: Record<string, string> = {};
    injectCredentials([wild], new URL("https://files.stripe.com/"), h);
    expect(h.Authorization).toBeDefined();
    const bare: Record<string, string> = {};
    injectCredentials([wild], new URL("https://stripe.com/"), bare);
    expect(bare.Authorization).toBeUndefined();
  });

  test("a test run gets a placeholder, never a value", () => {
    const [p] = placeholderCredentials([{ secret: "STRIPE_KEY", host: "api.stripe.com" }]);
    const h: Record<string, string> = {};
    const values = injectCredentials([p!], new URL("https://api.stripe.com/"), h);
    expect(h.Authorization).toBe("Bearer [vault:STRIPE_KEY]");
    expect(values).toEqual([]);
  });

  test("an echoed value is redacted", () => {
    const values = injectCredentials([stripe], new URL("https://api.stripe.com/"), {});
    expect(redact('{"echo":"Bearer vault-fixture-value-0001"}', values)).toBe(
      '{"echo":"[redacted:vault]"}'
    );
    expect(redact("nothing here", values)).toBe("nothing here");
  });
});
