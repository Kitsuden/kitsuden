/**
 * Kitsuden — Mail: layout and components
 * ============================================================================
 *
 * The equivalent of Laravel's Markdown Mailables: a shared layout plus
 * components (button, panel, table…), instead of inline HTML duplicated in each
 * email.
 *
 * Why functions and not a template engine: email HTML demands inline
 * styles and tables (Outlook does not support modern CSS), so a generic engine
 * does not help — what helps is that the styles live in ONE place. Here
 * the components encapsulate that ugliness and the email's author just composes.
 *
 *   content: (data, ctx) => ({
 *     html: layout({
 *       appName: ctx.appName,
 *       body: heading("Welcome") + paragraph("...") + button("Sign in", url),
 *     }),
 *   })
 *
 * ALL escaping goes here: any data entering a component is escaped,
 * because an email with unescaped user data is an HTML injection.
 */

export interface LayoutOptions {
  /** Already composed body (uses the components below). */
  body: string;
  appName?: string;
  /** Custom footer. Defaults to an automated-email notice. */
  footer?: string;
  /** Accent color for buttons and headings. */
  accent?: string;
  /** Preheader text (what is seen in the inbox before opening). */
  preheader?: string;
}

/** Escapes HTML. Applied to ALL dynamic data. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** Only allows http(s) and mailto: avoids `javascript:` in links. */
function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url.trim()) ? esc(url) : "#";
}

const ACCENT = "#0891b2";

/**
 * Email wrapper: centered table, safe typography and dark mode.
 * It uses tables and inline styles on purpose — it is the only thing that renders the same
 * in Outlook, Gmail and Apple Mail.
 */
export function layout(options: LayoutOptions): string {
  const accent = options.accent ?? ACCENT;
  const appName = esc(options.appName ?? "Kitsuden");
  const footer =
    options.footer ??
    `This email was sent by your instance of ${appName}. If you were not expecting this message, you can ignore it.`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${appName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;">
${
  options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(options.preheader)}</div>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:18px;font-weight:700;color:${accent};letter-spacing:-.01em;">${appName}</div>
      </td></tr>
      <tr><td style="padding:8px 32px 28px;color:#33333d;font-size:15px;line-height:1.65;">
${options.body}
      </td></tr>
      <tr><td style="padding:0 32px 28px;">
        <hr style="border:none;border-top:1px solid #e8e8ee;margin:0 0 16px;" />
        <p style="margin:0;color:#8b8b9a;font-size:12px;line-height:1.6;">${esc(footer)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Components ───────────────────────────────────────────────────────────────

export function heading(text: string): string {
  return `<h1 style="margin:0 0 14px;font-size:20px;font-weight:650;color:#16161d;line-height:1.35;">${esc(text)}</h1>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;color:#44444f;font-size:15px;line-height:1.65;">${esc(text)}</p>`;
}

/** Action button. The URL is validated (no `javascript:`). */
export function button(label: string, url: string, accent = ACCENT): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
  <tr><td style="border-radius:8px;background:${accent};">
    <a href="${safeUrl(url)}"
       style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:15px;font-weight:600;
              text-decoration:none;border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
}

/** Highlighted block (codes, notices). */
export function panel(text: string): string {
  return `<div style="margin:18px 0;padding:14px 16px;background:#f6f6fa;border-radius:8px;
              border-left:3px solid ${ACCENT};color:#44444f;font-size:14px;line-height:1.6;">${esc(text)}</div>`;
}

/** One-time code, in large monospace. */
export function code(value: string): string {
  return `<div style="margin:18px 0;padding:16px;background:#f6f6fa;border-radius:8px;text-align:center;
              font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;
              letter-spacing:.18em;color:#16161d;font-weight:600;">${esc(value)}</div>`;
}

/** Key/value table (order summaries, details). */
export function table(rows: [string, string][]): string {
  const body = rows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:8px 0;color:#8b8b9a;font-size:14px;">${esc(k)}</td>
          <td style="padding:8px 0;color:#16161d;font-size:14px;text-align:right;font-weight:500;">${esc(v)}</td>
        </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">${body}</table>`;
}

// ── Plain text ───────────────────────────────────────────────────────────────

/**
 * Derives the text alternative from the HTML.
 *
 * It matters more than it seems: without `text/plain` spam filters penalize
 * the message. By generating it automatically, no email is left without one.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      // Keep the link destination: "Sign in (https://…)"
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .trim()
  );
}
