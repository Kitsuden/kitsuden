/**
 * Visitor IP behind a reverse proxy (src/lib/client-ip.ts)
 */
import { describe, expect, it } from "vitest";

import { visitorIp } from "../src/lib/client-ip";

describe("visitorIp", () => {
  it("uses the socket address by default, ignoring X-Forwarded-For (the client writes it)", () => {
    expect(visitorIp("172.18.0.5", "203.0.113.9", false)).toBe("172.18.0.5");
  });

  it("behind a trusted proxy, takes the LAST X-Forwarded-For entry (the one the proxy added)", () => {
    expect(visitorIp("172.18.0.5", "1.2.3.4, 203.0.113.9", true)).toBe("203.0.113.9");
    expect(visitorIp("172.18.0.5", " 203.0.113.9 ", true)).toBe("203.0.113.9");
  });

  it("falls back to the socket address when the header is missing or empty", () => {
    expect(visitorIp("172.18.0.5", null, true)).toBe("172.18.0.5");
    expect(visitorIp("172.18.0.5", " , ", true)).toBe("172.18.0.5");
  });
});
