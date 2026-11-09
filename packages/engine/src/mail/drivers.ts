/**
 * Kitsuden — Mail: interchangeable drivers
 * ============================================================================
 *
 * The equivalent of Django's EMAIL_BACKEND and Laravel's mailers.
 * Changing provider means changing `MAIL_DRIVER`, never app code.
 *
 *   smtp     → nodemailer (any SMTP: Gmail, SES, Mailgun, Postmark…)
 *   resend   → Resend HTTP API (no npm dependency, uses fetch)
 *   log      → prints to console. Default in dev without credentials.
 *   memory   → stores in an array. It is the tests' backend (outbox).
 *
 * None is imported statically: `nodemailer` is loaded lazily only if the
 * smtp driver is used, so an app with Resend does not pay that cost.
 */

import type { MailDriver, SentMessage } from "./types";

// ── log ──────────────────────────────────────────────────────────────────────

/**
 * Prints the email to the console instead of sending it.
 * Default when there are no credentials: it NEVER breaks the flow for lack of
 * mail config (a user sign-up must not fail because SMTP is missing).
 */
export function logDriver(): MailDriver {
  return {
    name: "log",
    async send(message: SentMessage) {
      const line = "─".repeat(60);
      // eslint-disable-next-line no-console -- this driver IS the output
      console.log(
        `\n📧 ${line}\n` +
          `   To:      ${message.to.join(", ")}\n` +
          `   De:      ${message.from}\n` +
          `   Subject: ${message.subject}\n` +
          (message.cc.length ? `   CC:      ${message.cc.join(", ")}\n` : "") +
          (message.attachments.length
            ? `   Attachments: ${message.attachments.map((a) => a.filename).join(", ")}\n`
            : "") +
          `   Mailable: ${message.mailable} (${message.locale})\n` +
          `${line}\n${message.text.slice(0, 500)}\n${line}\n`
      );
      return { messageId: `log-${Date.now()}` };
    },
  };
}

// ── memory (test outbox) ─────────────────────────────────────────────────

export interface MemoryDriver extends MailDriver {
  /** All "sent" messages, in order. Django's `mail.outbox`. */
  readonly outbox: SentMessage[];
  clear(): void;
}

/**
 * Stores messages in memory instead of sending them.
 * It is what `mail.fake()` activates and what allows asserting in tests without touching
 * the network.
 */
export function memoryDriver(): MemoryDriver {
  const outbox: SentMessage[] = [];
  return {
    name: "memory",
    outbox,
    clear() {
      outbox.length = 0;
    },
    async send(message: SentMessage) {
      const messageId = `memory-${outbox.length + 1}`;
      outbox.push({ ...message, messageId });
      return { messageId };
    },
  };
}

// ── smtp ─────────────────────────────────────────────────────────────────────

export interface SmtpOptions {
  host: string;
  port?: number;
  user?: string;
  pass?: string;
  /** true for 465 (implicit TLS); false for 587 (STARTTLS). */
  secure?: boolean;
}

/** Sends over SMTP with nodemailer (lazy loading). */
export function smtpDriver(options: SmtpOptions): MailDriver {
  let transporter: any = null;

  async function getTransporter(): Promise<any> {
    if (transporter) return transporter;
    // Lazy: an app with Resend must not pay the cost of loading nodemailer.
    // The import carries @ts-ignore because `nodemailer` is a dependency of the HOST
    // (apps/api), not of the engine — the engine must not declare it so as not to force
    // its installation on whoever uses another driver. It is resolved at runtime.
    // @ts-ignore - optional host dependency
    const mod: any = await import("nodemailer");
    const nodemailer = mod.default ?? mod;
    transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port ?? 587,
      secure: options.secure ?? false,
      ...(options.user && options.pass ? { auth: { user: options.user, pass: options.pass } } : {}),
    });
    return transporter;
  }

  return {
    name: "smtp",
    async verify() {
      try {
        await (await getTransporter()).verify();
        return true;
      } catch {
        return false;
      }
    },
    async send(message: SentMessage) {
      const info = await (
        await getTransporter()
      ).sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc.length ? message.cc : undefined,
        bcc: message.bcc.length ? message.bcc : undefined,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          path: a.path,
          contentType: a.contentType,
          cid: a.cid,
        })),
      });
      return { messageId: info?.messageId };
    },
  };
}

// ── resend ───────────────────────────────────────────────────────────────────

export interface ResendOptions {
  apiKey: string;
  /** Alternative endpoint (self-host / proxy). */
  endpoint?: string;
}

/**
 * Sends through Resend's HTTP API. No npm dependency: only `fetch`, so the
 * most widely used driver today for deliverability adds no weight to the package.
 */
export function resendDriver(options: ResendOptions): MailDriver {
  const endpoint = options.endpoint ?? "https://api.resend.com/emails";

  return {
    name: "resend",
    async send(message: SentMessage) {
      const body: Record<string, unknown> = {
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.cc.length ? { cc: message.cc } : {}),
        ...(message.bcc.length ? { bcc: message.bcc } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.tag ? { tags: [{ name: "mailable", value: message.mailable }] } : {}),
      };

      if (message.attachments.length > 0) {
        body.attachments = message.attachments.map((a) => ({
          filename: a.filename,
          content:
            typeof a.content === "string"
              ? a.content
              : a.content
                ? Buffer.from(a.content).toString("base64")
                : undefined,
          path: a.path,
        }));
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 200)}`);
      }

      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { messageId: json.id };
    },
  };
}

// ── Resolution by environment ────────────────────────────────────────────────

/**
 * Builds the driver from environment variables.
 *
 * Order: explicit `MAIL_DRIVER` → Resend if there is an API key → SMTP if there is a host →
 * log. It never throws: without config, the email is logged and the app carries on.
 */
export function driverFromEnv(env: Record<string, string | undefined> = process.env): MailDriver {
  const explicit = env.MAIL_DRIVER?.toLowerCase();

  if (explicit === "memory") return memoryDriver();
  if (explicit === "log") return logDriver();

  if (explicit === "resend" || (!explicit && env.RESEND_API_KEY)) {
    if (!env.RESEND_API_KEY) return logDriver();
    return resendDriver({ apiKey: env.RESEND_API_KEY });
  }

  if (explicit === "smtp" || (!explicit && env.SMTP_HOST)) {
    if (!env.SMTP_HOST) return logDriver();
    return smtpDriver({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT) || 587,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      secure: env.SMTP_SECURE === "true",
    });
  }

  return logDriver();
}
