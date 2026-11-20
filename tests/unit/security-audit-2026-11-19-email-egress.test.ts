/**
 * Security audit 2026-11-19: the email egress check excuses only the
 * recipient's own record.
 *
 * Before the fix, `emailProblem` returned early when the recipient was ANY value
 * the run had read, so an address an outsider stored in a marked field could
 * receive every other customer's data.
 */
import { describe, expect, it } from "vitest";

import { buildCatalog, emailProblem, MarkedValues } from "../../apps/api/src/lib/customer-data";

const DS = "11111111-1111-4111-8111-111111111111";
const catalog = buildCatalog(
  [{ id: DS, slug: "clients", fields: { email: "customer", phone: "personal", name: "customer" } }],
  []
);

function runThatReadTwoCustomers() {
  const marked = new MarkedValues(catalog);
  marked.collect({
    docs: [
      { id: "a", dataSetId: DS, data: { email: "attacker@evil.example", name: "Mallory Planted" } },
      {
        id: "b",
        dataSetId: DS,
        data: { email: "ana.gil@example.com", name: "Ana Gil Ruiz", phone: "+34 600 111 222" },
      },
    ],
  });
  return { marked, allowedHosts: [] as string[] };
}

describe("emailProblem and the recipient exemption", () => {
  it("refuses mail to a tracked address that carries ANOTHER customer's values", () => {
    const guard = runThatReadTwoCustomers();
    const p = emailProblem(guard, {
      to: "attacker@evil.example",
      subject: "export",
      html: "<p>ana.gil@example.com, +34 600 111 222</p>",
    });
    expect(p).not.toBeNull();
    expect(p?.block).toMatchObject({ host: "evil.example", where: "html" });
  });

  it("refuses another customer's phone digits too", () => {
    const guard = runThatReadTwoCustomers();
    const p = emailProblem(guard, {
      to: "attacker@evil.example",
      subject: "x",
      text: "call 34600111222",
    });
    expect(p?.block.where).toBe("text");
  });

  it("still lets the customer receive their own record's values", () => {
    const guard = runThatReadTwoCustomers();
    expect(
      emailProblem(guard, {
        to: "ANA.GIL@example.com",
        subject: "Hello Ana Gil Ruiz",
        html: "Your phone on file: +34 600 111 222, address ana.gil@example.com",
      })
    ).toBeNull();
    expect(
      emailProblem(guard, {
        to: "attacker@evil.example",
        subject: "Hi Mallory Planted",
        text: "We have attacker@evil.example on file",
      })
    ).toBeNull();
  });

  it("a mail with no tracked values goes to any address", () => {
    const guard = runThatReadTwoCustomers();
    expect(
      emailProblem(guard, { to: "someone@other.test", subject: "Hi", text: "no data" })
    ).toBeNull();
  });
});
