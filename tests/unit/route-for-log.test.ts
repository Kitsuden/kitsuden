/**
 * No single-use token in the access log (earlier audit):
 * `GET /api/auth/reset-password/<token>` used to be written as is.
 */
import { describe, expect, it } from "vitest";

import { accessLineWithoutSecrets, logPath } from "../../apps/api/src/lib/route-for-log";

describe("logPath", () => {
  it("masks the reset token and the invitation ones", () => {
    expect(logPath("/api/auth/reset-password/AbCdEf123456")).toBe("/api/auth/reset-password/***");
    expect(logPath("/api/esports/invites/xyz/accept")).toBe("/api/esports/invites/***/accept");
  });

  it("masks long opaque segments and the query", () => {
    expect(logPath(`/api/x/${"a1B2".repeat(10)}`)).toBe("/api/x/***");
    expect(logPath("/api/auth/verify-email?token=secret")).toBe("/api/auth/verify-email?***");
  });

  it("leaves UUIDs and normal routes alone (they help with debugging)", () => {
    const uuid = "6f1c2a9e-1d2b-4c3d-9e8f-0a1b2c3d4e5f";
    expect(logPath(`/api/data-sets/${uuid}/entries`)).toBe(`/api/data-sets/${uuid}/entries`);
    expect(logPath("/api/blog/my-post")).toBe("/api/blog/my-post");
  });

  it("hono/logger format", () => {
    expect(accessLineWithoutSecrets("<-- GET /api/auth/reset-password/tok123")).toBe(
      "<-- GET /api/auth/reset-password/***"
    );
    expect(accessLineWithoutSecrets("--> GET /api/blog 200 3ms")).toBe("--> GET /api/blog 200 3ms");
  });
});
