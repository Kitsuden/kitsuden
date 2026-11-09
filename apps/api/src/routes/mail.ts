/**
 * Mail — Inspection and preview routes
 * ============================================================================
 *
 *   GET  /api/mail                    → Registered mailables (core + kons)
 *   POST /api/mail/preview            → renders WITHOUT sending
 *   POST /api/mail/test               → sends a real test
 *
 * They serve the admin (previewing templates before publishing them) and
 * agents via MCP (discovering which emails exist and what they look like).
 *
 * Requires admin: previewing reveals templates and the test send consumes
 * the provider's quota.
 */

import { mail } from "@kitsuden/engine";
import { Hono } from "hono";

import { protectRoute, requireAdmin } from "../middleware/auth-guard";

export const mailRoutes = new Hono();

mailRoutes.use("/*", protectRoute, requireAdmin);

/** Catalog of available emails. */
mailRoutes.get("/", (c) => {
  const names = mail.list();
  return c.json({
    driver: mail.driverName,
    total: names.length,
    // Grouped by prefix: "system.*" from the core, "crm.*" from the CRM kon…
    mailables: names.map((name) => ({
      name,
      owner: name.includes(".") ? name.split(".")[0] : "app",
    })),
  });
});

/**
 * Renders a Mailable without sending it. Returns subject, HTML and text — what
 * the admin shows in the preview iframe.
 */
mailRoutes.post("/preview", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    data?: Record<string, unknown>;
    locale?: string;
  };

  if (!body.name) {
    return c.json({ error: { code: "VALIDATION", message: "Missing 'name'" } }, 400);
  }
  if (!mail.has(body.name)) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Mailable "${body.name}" not registered`,
          available: mail.list(),
        },
      },
      404
    );
  }

  try {
    const message = mail.render(body.name, body.data ?? {}, body.locale);
    return c.json({
      name: message.mailable,
      locale: message.locale,
      subject: message.subject,
      html: message.html,
      text: message.text,
      to: message.to,
      attachments: message.attachments.map((a) => a.filename),
    });
  } catch (err) {
    // A Mailable can fail if data is missing: the reason is returned
    // instead of an opaque 500, because whoever previews is iterating on the payload.
    return c.json(
      {
        error: {
          code: "RENDER_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      },
      422
    );
  }
});

/** Sends a real test email (useful to validate SMTP/Resend). */
mailRoutes.post("/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    to?: string;
    data?: Record<string, unknown>;
    locale?: string;
  };

  if (!body.name || !body.to) {
    return c.json({ error: { code: "VALIDATION", message: "Missing 'name' and 'to'" } }, 400);
  }
  if (!mail.has(body.name)) {
    return c.json(
      { error: { code: "NOT_FOUND", message: `Mailable "${body.name}" not registered` } },
      404
    );
  }

  const result = await mail.send(body.name, { ...(body.data ?? {}), to: body.to }, body.locale);

  return c.json(
    {
      ok: result.ok,
      driver: mail.driverName,
      messageId: result.messageId,
      error: result.error,
      subject: result.message.subject,
      to: result.message.to,
    },
    result.ok ? 200 : 502
  );
});
