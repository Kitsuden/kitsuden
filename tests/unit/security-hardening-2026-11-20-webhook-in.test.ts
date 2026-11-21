/**
 * Incoming webhook checks fail closed (hardening 2026-11-20)
 * ============================================================================
 *
 * `authType: "bearer"` with an empty secret accepted any request (HMAC already
 * refused), and the HMAC was computed over a re-serialized parsed body instead of
 * the raw bytes the sender signed.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  executeWebhookInAction,
  validateBearerToken,
} from "../../apps/api/src/lib/actions/handlers/webhook-in-handler";

const action = (config: Record<string, unknown>) => ({ id: "a1", config }) as never;
const context = {} as never;
const request = (headers: Record<string, string>, body: unknown) => ({
  method: "POST",
  path: "/",
  headers,
  body,
});

describe("bearer", () => {
  it("an empty or missing secret refuses, with or without a header", async () => {
    expect(validateBearerToken(request({}, {}), {})).toBe(false);
    expect(validateBearerToken(request({ authorization: "Bearer " }, {}), { secret: "" })).toBe(
      false
    );
    const r = await executeWebhookInAction(
      action({ authType: "bearer", secret: "" }),
      context,
      request({}, {})
    );
    expect(r.success).toBe(false);
  });

  it("the right secret still passes", () => {
    expect(
      validateBearerToken(request({ authorization: "Bearer s3cret" }, {}), { secret: "s3cret" })
    ).toBe(true);
  });
});

describe("hmac", () => {
  const secret = "k3y";
  const raw = '{"b":1,  "a":2}';
  const sig = createHmac("sha256", secret).update(raw).digest("hex");

  it("checks the raw string body the sender signed", async () => {
    const r = await executeWebhookInAction(
      action({ authType: "hmac", secret }),
      context,
      request({ "x-signature": `sha256=${sig}` }, raw)
    );
    expect(r.success).toBe(true);
  });

  it("refuses a parsed body, even one whose re-serialization would match", async () => {
    const parsed = { b: 1, a: 2 };
    const reSig = createHmac("sha256", secret).update(JSON.stringify(parsed)).digest("hex");
    const r = await executeWebhookInAction(
      action({ authType: "hmac", secret }),
      context,
      request({ "x-signature": reSig }, parsed)
    );
    expect(r.success).toBe(false);
  });
});
