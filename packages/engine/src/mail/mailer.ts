/**
 * Kitsuden — Mail: the Mailer
 * ============================================================================
 *
 * Puts the pieces together: registry of Mailables (including those of kons),
 * interchangeable drivers, localization and the `fake()` mode for tests.
 *
 *   mail.register(welcomeMail);              // a kon registers its own
 *   await mail.send("welcome", { name });    // send
 *
 *   mail.fake();                             // in tests
 *   mail.assertSent("welcome", m => m.to.includes("a@b.com"));
 *
 * The Mailer is a CLASS with an exported default instance. The class
 * allows isolated mailers in concurrent tests; the default instance is the one
 * the app uses.
 */

import { driverFromEnv, memoryDriver, type MemoryDriver } from "./drivers";
import { htmlToText } from "./templates";
import {
  addressEmail,
  formatAddress,
  type Address,
  type MailContext,
  type MailDriver,
  type Mailable,
  type SentMessage,
} from "./types";

export interface MailerOptions {
  driver?: MailDriver;
  /** Default sender if the Mailable does not specify one. */
  from?: Address;
  appName?: string;
  appUrl?: string;
  defaultLocale?: string;
  /** Translations: `{ es: { "mail.greeting": "Hola" } }`. */
  translations?: Record<string, Record<string, string>>;
}

/** Result of a send. */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  message: SentMessage;
}

const asArray = (v: Address | Address[] | undefined): Address[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export class Mailer {
  private mailables = new Map<string, Mailable<any>>();
  private driver: MailDriver;
  private options: Required<Omit<MailerOptions, "driver" | "from">> & { from: Address };
  /** Real driver, kept while `fake()` is active. */
  private realDriver: MailDriver | null = null;

  constructor(options: MailerOptions = {}) {
    this.driver = options.driver ?? driverFromEnv();
    this.options = {
      from: options.from ?? process.env.MAIL_FROM ?? "noreply@localhost",
      appName: options.appName ?? process.env.APP_NAME ?? "Kitsuden",
      appUrl: options.appUrl ?? process.env.APP_URL ?? "http://localhost:3000",
      defaultLocale: options.defaultLocale ?? process.env.MAIL_LOCALE ?? "en",
      translations: options.translations ?? {},
    };
  }

  // ── Registry (what lets a kon contribute its emails) ────────────────────

  /**
   * Registers a Mailable. A kon calls this in its startup hook and its
   * emails become available to the whole app — without touching the host.
   */
  register<T>(mailable: Mailable<T>): this {
    if (this.mailables.has(mailable.name)) {
      console.warn(`  ⚠️  Mailable "${mailable.name}" is being re-registered`);
    }
    this.mailables.set(mailable.name, mailable);
    return this;
  }

  /** Registers several at once. */
  registerAll(mailables: Mailable<any>[]): this {
    for (const m of mailables) this.register(m);
    return this;
  }

  has(name: string): boolean {
    return this.mailables.has(name);
  }

  /** Registered names (for diagnostics and for the admin). */
  list(): string[] {
    return Array.from(this.mailables.keys()).sort();
  }

  // ── Localization ──────────────────────────────────────────────────────────

  /** Adds/merges translations for a locale (a kon can contribute its own). */
  addTranslations(locale: string, entries: Record<string, string>): this {
    this.options.translations[locale] = {
      ...(this.options.translations[locale] ?? {}),
      ...entries,
    };
    return this;
  }

  private contextFor(locale?: string): MailContext {
    const active = locale ?? this.options.defaultLocale;
    const dict = this.options.translations[active] ?? {};
    const fallback = this.options.translations[this.options.defaultLocale] ?? {};

    return {
      locale: active,
      appUrl: this.options.appUrl,
      appName: this.options.appName,
      t: (key, vars) => {
        // active locale → default locale → the key itself (never empty)
        let out = dict[key] ?? fallback[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            out = out.replaceAll(`{${k}}`, String(v));
          }
        }
        return out;
      },
    };
  }

  // ── Render + send ─────────────────────────────────────────────────────────

  /** Renders without sending — useful for previewing in the admin and for tests. */
  render<T>(name: string, data: T, locale?: string): SentMessage {
    const mailable = this.mailables.get(name);
    if (!mailable) {
      throw new Error(
        `Mailable "${name}" is not registered. Available: ${this.list().join(", ") || "(none)"}`
      );
    }

    const ctx = this.contextFor(locale);
    const envelope = mailable.envelope(data, ctx);
    const content = mailable.content(data, ctx);
    const attachments = mailable.attachments?.(data, ctx) ?? [];

    const html = content.html ?? "";
    // Without text/plain, spam filters penalize: it is always derived.
    const text = content.text ?? htmlToText(html);

    return {
      mailable: name,
      to: asArray(envelope.to).map(formatAddress),
      from: formatAddress(envelope.from ?? this.options.from),
      cc: asArray(envelope.cc).map(formatAddress),
      bcc: asArray(envelope.bcc).map(formatAddress),
      replyTo: envelope.replyTo ? formatAddress(envelope.replyTo) : undefined,
      subject: envelope.subject,
      html,
      text,
      attachments,
      headers: envelope.headers ?? {},
      locale: ctx.locale,
      tag: envelope.tag,
      sentAt: new Date().toISOString(),
    };
  }

  /**
   * Sends a Mailable.
   *
   * It does NOT throw if the driver fails: it returns `{ ok: false, error }`. A
   * failed email must not bring down the operation that originated it (a user
   * sign-up cannot fail because SMTP is saturated). Whoever needs the failure
   * to be explicit checks `result.ok`.
   */
  async send<T>(name: string, data: T, locale?: string): Promise<SendResult> {
    // `render` DOES propagate, unlike sending: an unregistered Mailable is
    // a programming error, not a mail incident, and must not end up
    // camouflaged in a `{ ok: false }` alongside recoverable failures.
    // (This was a `try { ... } catch (err) { throw err }`, which did exactly
    // this with more noise.)
    const message: SentMessage = this.render(name, data, locale);

    if (message.to.length === 0) {
      return { ok: false, error: "No recipients", message };
    }

    try {
      const { messageId } = await this.driver.send(message);
      return { ok: true, messageId, message: { ...message, messageId } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      console.error(`  ✉️  Failed to send "${name}": ${error}`);
      return { ok: false, error, message };
    }
  }

  // ── Driver ────────────────────────────────────────────────────────────────

  setDriver(driver: MailDriver): this {
    this.driver = driver;
    return this;
  }

  get driverName(): string {
    return this.driver.name;
  }

  /** Verifies the driver's connection (if it supports it). */
  async verify(): Promise<boolean> {
    return this.driver.verify ? this.driver.verify() : true;
  }

  // ── Testing (Laravel's Mail::fake + Django's outbox) ────────────────────

  private get outbox(): SentMessage[] {
    const mem = this.driver as MemoryDriver;
    if (!mem.outbox) {
      throw new Error("mail.fake() is not active — call mail.fake() first.");
    }
    return mem.outbox;
  }

  /**
   * Replaces the driver with the in-memory one: nothing goes out to the network and everything
   * stays in the outbox for asserting. It keeps the real driver to restore it.
   */
  fake(): this {
    if (!this.realDriver) this.realDriver = this.driver;
    this.driver = memoryDriver();
    return this;
  }

  /** Restores the real driver and empties the outbox. */
  restore(): this {
    if (this.realDriver) {
      this.driver = this.realDriver;
      this.realDriver = null;
    }
    return this;
  }

  /** All captured messages (Django's `mail.outbox`). */
  sent(name?: string): SentMessage[] {
    const all = this.outbox;
    return name ? all.filter((m) => m.mailable === name) : all;
  }

  clearSent(): this {
    (this.driver as MemoryDriver).clear?.();
    return this;
  }

  /** Was this Mailable sent (and optionally meeting a predicate)? */
  wasSent(name: string, predicate?: (m: SentMessage) => boolean): boolean {
    const matches = this.sent(name);
    return predicate ? matches.some(predicate) : matches.length > 0;
  }

  /** Assertion: throws with useful context if it was not sent. */
  assertSent(name: string, predicate?: (m: SentMessage) => boolean): void {
    if (this.wasSent(name, predicate)) return;
    const sentItems = this.outbox.map((m) => m.mailable);
    throw new Error(
      predicate
        ? `Expected "${name}" to be sent matching the predicate, but none matches. Sent: [${sentItems.join(", ")}]`
        : `Expected "${name}" to be sent. Sent: [${sentItems.join(", ") || "none"}]`
    );
  }

  /** Inverse assertion. */
  assertNotSent(name: string): void {
    if (this.sent(name).length === 0) return;
    throw new Error(
      `Did not expect to send "${name}", but it was sent ${this.sent(name).length} time(s).`
    );
  }

  /** Count assertion. */
  assertSentCount(name: string, expected: number): void {
    const actual = this.sent(name).length;
    if (actual !== expected) {
      throw new Error(`Expected ${expected} sends of "${name}", got ${actual}.`);
    }
  }

  /** Recipient assertion, regardless of the "Name <a@b>" format. */
  assertSentTo(name: string, email: string): void {
    this.assertSent(name, (m) =>
      m.to.some((t) => addressEmail(t).toLowerCase().includes(email.toLowerCase()))
    );
  }
}

/** Default instance — the one the app uses. */
export const mail = new Mailer();
