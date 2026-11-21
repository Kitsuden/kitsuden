/**
 * Hardening 2026-11-20: a `core:send-mail` step fills recipient placeholders as text.
 *
 * A whole placeholder keeps the type of the event value, so
 * `"to": "{{event.email}}"` with an event carrying a list handed the mailer a
 * list: the email went to every address in it. Recipient keys (`to`, `cc`,
 * `bcc`, `replyTo`) are now always filled as text; a list becomes its JSON form,
 * which the mailer refuses as an address. Other keys keep their type.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("the database is not available in this test");
      },
    }
  ),
  isLiteMode: false,
}));

const { mail } = await import("../../packages/engine/src/mail");
const { dryRunAction } = await import("../../apps/api/src/lib/actions/rules");

mail.register({
  name: "hardening.notify",
  envelope: (d: { to: string }) => ({ to: d.to, subject: "New entry" }),
  content: () => ({ html: "<p>x</p>" }),
});

function rule(data: Record<string, unknown>) {
  return {
    id: "rule-1",
    name: "Notify",
    type: "rule",
    trigger: "event",
    triggerConfig: { eventName: "entry.created" },
    config: {
      steps: [{ handler: "core:send-mail", config: { mailable: "hardening.notify", data } }],
    },
  } as never;
}

describe("core:send-mail recipients", () => {
  it("a list in the event does not become several recipients", async () => {
    const result = await dryRunAction(rule({ to: "{{event.email}}", count: "{{event.count}}" }), {
      payload: { email: ["ada@example.com", "eve@evil.test"], count: 3 },
    });
    const config = result.steps[0]!.config as { data: Record<string, unknown> };
    expect(typeof config.data.to).toBe("string");
    expect(config.data.to).toBe('["ada@example.com","eve@evil.test"]');
    // Other keys keep the type of the event value.
    expect(config.data.count).toBe(3);

    const sent = await mail.send("hardening.notify", config.data);
    expect(sent.ok).toBe(false);
  });

  it("a single address still works", async () => {
    const result = await dryRunAction(rule({ to: "{{event.email}}" }), {
      payload: { email: "ada@example.com" },
    });
    const config = result.steps[0]!.config as { data: Record<string, unknown> };
    expect(config.data.to).toBe("ada@example.com");
    expect(result.steps[0]!.problem).toBeUndefined();
  });
});
