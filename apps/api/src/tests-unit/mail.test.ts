import { existsSync } from "node:fs";
/**
 * Mail — Mailables, drivers, outbox and localization
 * ============================================================================
 *
 * Before, there was NO way to assert "the welcome email was sent" without
 * touching SMTP. This is the equivalent of Laravel's `Mail::fake()` and of
 * `django.core.mail.outbox`: the in-memory driver captures the messages and
 * they are asserted without a network.
 */

import {
  Mailer,
  layout,
  heading,
  paragraph,
  button,
  htmlToText,
  memoryDriver,
  type Mailable,
} from "@kitsuden/engine";
import { describe, expect, test, beforeEach } from "bun:test";

interface WelcomeData {
  to: string;
  name: string;
}

const welcome: Mailable<WelcomeData> = {
  name: "welcome",
  envelope: (d, ctx) => ({
    to: d.to,
    subject: ctx.t("greeting", { name: d.name }),
    cc: "audit@example.com",
    tag: "onboarding",
  }),
  content: (d, ctx) => ({
    html: layout({
      appName: ctx.appName,
      body:
        heading(`Hello ${d.name}`) + paragraph("Welcome aboard") + button("Sign in", ctx.appUrl),
    }),
  }),
};

const withAttachment: Mailable<{ to: string }> = {
  name: "invoice",
  envelope: (d) => ({ to: d.to, subject: "Your invoice" }),
  content: () => ({ html: "<p>The invoice is attached.</p>" }),
  attachments: () => [
    { filename: "invoice.pdf", content: "PDF-DATA", contentType: "application/pdf" },
  ],
};

function newMailer() {
  const m = new Mailer({
    driver: memoryDriver(),
    from: { address: "no-reply@kitsuden.dev", name: "Kitsuden" },
    appName: "Kitsuden",
    appUrl: "https://app.kitsuden.dev",
    defaultLocale: "en",
    translations: {
      en: { greeting: "Welcome, {name}" },
      es: { greeting: "Bienvenido, {name}" },
    },
  });
  m.register(welcome).register(withAttachment);
  return m;
}

let mailer: Mailer;
beforeEach(() => {
  mailer = newMailer();
});

describe("Mailable registry (what a kon uses)", () => {
  test("register / has / list", () => {
    expect(mailer.has("welcome")).toBe(true);
    expect(mailer.list()).toEqual(["invoice", "welcome"]);
  });

  test("sending an unregistered Mailable THROWS (programming error)", async () => {
    await expect(mailer.send("doesNotExist", {})).rejects.toThrow(/is not registered/);
  });

  test("a 'kon' can register its own after startup", async () => {
    mailer.register({
      name: "crm.deal-won",
      envelope: (d: any) => ({ to: d.to, subject: "Deal won" }),
      content: () => ({ html: "<p>🎉</p>" }),
    });
    const r = await mailer.send("crm.deal-won", { to: "sales@example.com" });
    expect(r.ok).toBe(true);
    mailer.assertSent("crm.deal-won");
  });
});

describe("envelope: to/cc/from/tag", () => {
  test("uses the default from when the Mailable does not declare one", async () => {
    const r = await mailer.send("welcome", { to: "a@b.com", name: "Ada" });
    expect(r.message.from).toBe("Kitsuden <no-reply@kitsuden.dev>");
  });

  test("cc and tag reach the message", async () => {
    const r = await mailer.send("welcome", { to: "a@b.com", name: "Ada" });
    expect(r.message.cc).toEqual(["audit@example.com"]);
    expect(r.message.tag).toBe("onboarding");
  });

  test("without recipients nothing is sent", async () => {
    mailer.register({
      name: "empty",
      envelope: () => ({ to: [], subject: "x" }),
      content: () => ({ html: "x" }),
    });
    const r = await mailer.send("empty", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No recipients");
  });
});

describe("localization", () => {
  test("translates by locale and interpolates variables", async () => {
    const en = await mailer.send("welcome", { to: "a@b.com", name: "Ada" });
    expect(en.message.subject).toBe("Welcome, Ada");

    const es = await mailer.send("welcome", { to: "a@b.com", name: "Ada" }, "es");
    expect(es.message.subject).toBe("Bienvenido, Ada");
    expect(es.message.locale).toBe("es");
  });

  test("unknown locale falls back to the default, not to empty", async () => {
    const r = await mailer.send("welcome", { to: "a@b.com", name: "Ada" }, "fr");
    expect(r.message.subject).toBe("Welcome, Ada");
  });

  test("a key without a translation returns the key (never an empty string)", () => {
    mailer.register({
      name: "noTranslation",
      envelope: (_d, ctx) => ({ to: "a@b.com", subject: ctx.t("missing.key") }),
      content: () => ({ html: "x" }),
    });
    expect(mailer.render("noTranslation", {}).subject).toBe("missing.key");
  });
});

describe("content", () => {
  test("derives text/plain from the HTML if none is given (avoids a spam penalty)", async () => {
    const r = await mailer.send("welcome", { to: "a@b.com", name: "Ada" });
    expect(r.message.text.length).toBeGreaterThan(0);
    expect(r.message.text).toContain("Hello Ada");
    expect(r.message.text).not.toContain("<");
  });

  test("htmlToText keeps the link destination", () => {
    const text = htmlToText('<a href="https://x.dev/reset">Sign in</a>');
    expect(text).toContain("https://x.dev/reset");
  });

  test("escapes user data (defense against HTML injection)", () => {
    const msg = mailer.render("welcome", { to: "a@b.com", name: "<script>alert(1)</script>" });
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });

  test("button rejects dangerous URLs", () => {
    expect(button("Click", "javascript:alert(1)")).toContain('href="#"');
    expect(button("Click", "https://ok.dev")).toContain('href="https://ok.dev"');
  });
});

describe("attachments", () => {
  test("they travel in the message", async () => {
    const r = await mailer.send("invoice", { to: "a@b.com" });
    expect(r.message.attachments).toHaveLength(1);
    expect(r.message.attachments[0].filename).toBe("invoice.pdf");
  });
});

describe("fake() + outbox + assertions", () => {
  test("assertSent / assertNotSent", async () => {
    mailer.fake();
    await mailer.send("welcome", { to: "ada@example.com", name: "Ada" });

    mailer.assertSent("welcome");
    mailer.assertNotSent("invoice");
    expect(() => mailer.assertSent("invoice")).toThrow(/to be sent/);
  });

  test("assertSent with a predicate", async () => {
    mailer.fake();
    await mailer.send("welcome", { to: "ada@example.com", name: "Ada" });

    mailer.assertSent("welcome", (m) => m.subject.includes("Ada"));
    expect(() => mailer.assertSent("welcome", (m) => m.subject.includes("Bob"))).toThrow(
      /predicate/
    );
  });

  test("assertSentTo ignores the 'Name <email>' format", async () => {
    mailer.fake();
    mailer.register({
      name: "withName",
      envelope: () => ({ to: { address: "ada@example.com", name: "Ada L." }, subject: "x" }),
      content: () => ({ html: "x" }),
    });
    await mailer.send("withName", {});
    mailer.assertSentTo("withName", "ada@example.com");
  });

  test("assertSentCount", async () => {
    mailer.fake();
    await mailer.send("welcome", { to: "a@b.com", name: "A" });
    await mailer.send("welcome", { to: "c@d.com", name: "C" });

    mailer.assertSentCount("welcome", 2);
    expect(() => mailer.assertSentCount("welcome", 1)).toThrow(/expected 1 sends/i);
  });

  test("the outbox keeps the order and can be cleared", async () => {
    mailer.fake();
    await mailer.send("welcome", { to: "a@b.com", name: "A" });
    await mailer.send("invoice", { to: "a@b.com" });

    expect(mailer.sent().map((m) => m.mailable)).toEqual(["welcome", "invoice"]);
    mailer.clearSent();
    expect(mailer.sent()).toHaveLength(0);
  });

  test("restore() returns the real driver", () => {
    const before = mailer.driverName;
    mailer.fake();
    mailer.restore();
    expect(mailer.driverName).toBe(before);
  });
});

describe("resilience", () => {
  test("a driver that fails does NOT throw: it returns ok:false", async () => {
    const m = newMailer();
    m.setDriver({
      name: "broken",
      async send() {
        throw new Error("SMTP down");
      },
    });

    const r = await m.send("welcome", { to: "a@b.com", name: "Ada" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SMTP down");
    // The rendered message is still available for diagnosis.
    expect(r.message.subject).toBe("Welcome, Ada");
  });
});

describe("render() without sending (admin preview)", () => {
  test("returns the full message without touching the driver", () => {
    const msg = mailer.render("welcome", { to: "a@b.com", name: "Ada" }, "es");
    expect(msg.subject).toBe("Bienvenido, Ada");
    expect(msg.html).toContain("<!doctype html>");
    expect(mailer.sent()).toHaveLength(0); // nothing was sent
  });
});

// kon-crm is an INSTALLABLE kon (kitsuden-kons repo): without it, this test
// has nothing to test and is skipped, instead of failing a clean clone of the core.
const CRM_MAILS = new URL("../../../../packages/kons/kon-crm/crm.mails.ts", import.meta.url);

describe("a kon provides its own emails (plugin requirement)", () => {
  test.skipIf(!existsSync(CRM_MAILS))(
    "kon-crm registers its Mailable and its translations in the shared Mailer",
    async () => {
      const { registerCrmMails } = await import(CRM_MAILS.href);

      const m = new Mailer({
        driver: memoryDriver(),
        from: "no-reply@kitsuden.dev",
        appName: "Kitsuden",
        appUrl: "https://app.kitsuden.dev",
        defaultLocale: "en",
      });

      // The kon only receives the Mailer — it does not touch the host or the mail config.
      registerCrmMails(m);
      expect(m.has("crm.deal-won")).toBe(true);

      const r = await m.send("crm.deal-won", {
        to: "sales@example.com",
        dealName: "ACME annual",
        amount: "12.000 €",
        companyName: "ACME",
        dealUrl: "https://app.kitsuden.dev/crm/deals/1",
      });

      expect(r.ok).toBe(true);
      m.assertSentTo("crm.deal-won", "sales@example.com");
      // It uses the engine's shared layout, not duplicated HTML of its own.
      expect(r.message.html).toContain("<!doctype html>");
      expect(r.message.subject).toBe("Deal won: ACME annual");

      // And its translations work too.
      const es = m.render(
        "crm.deal-won",
        { to: "x@y.z", dealName: "ACME annual", amount: "12.000 €", companyName: "ACME" },
        "es"
      );
      expect(es.subject).toBe("Trato ganado: ACME annual");
    }
  );
});
