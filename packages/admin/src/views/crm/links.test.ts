import { describe, expect, it } from "vitest";

import { crmHref } from "./links";

describe("CRM dashboard links", () => {
  it("lead to kon-crm's views and record pages, never to a /crm route", () => {
    expect(crmHref("deals")).toBe("/g/kon-crm/deals");
    expect(crmHref("deals", "new")).toBe("/g/kon-crm/deals/new");
    expect(crmHref("contacts", "c-1")).toBe("/g/kon-crm/contacts/c-1");
    expect(crmHref("companies", "a/b")).toBe("/g/kon-crm/companies/a%2Fb");
    for (const href of [crmHref("deals", "x"), crmHref("contacts"), crmHref("companies", "y")]) {
      expect(href.startsWith("/crm/")).toBe(false);
    }
  });
});
