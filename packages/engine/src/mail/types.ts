/**
 * Kitsuden — Mail: contracts
 * ============================================================================
 *
 * The model is Laravel's (Mailable + drivers + fake) with the best of
 * Django (interchangeable backends + outbox for tests), adapted to TypeScript
 * without mandatory classes or magic.
 *
 * A Mailable declares WHAT to send (recipients, subject, content, attachments);
 * the driver decides HOW. Nothing here knows about SMTP, the DB or the host — it is a
 * pure engine module, so a kon can define its emails without
 * dragging in infrastructure.
 */

// ── Addresses ────────────────────────────────────────────────────────────────

/** `"a@b.com"` o `{ address, name }`. */
export type Address = string | { address: string; name?: string };

/** Normalizes an address to the canonical header form. */
export function formatAddress(addr: Address): string {
  if (typeof addr === "string") return addr;
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

/** Extracts only the email (without the name) — useful for deduplicating and asserting. */
export function addressEmail(addr: Address): string {
  return typeof addr === "string" ? addr : addr.address;
}

// ── Attachments ──────────────────────────────────────────────────────────────

export interface Attachment {
  /** Name it appears under in the mail client. */
  filename: string;
  /** In-memory content. Mutually exclusive with `path`. */
  content?: string | Uint8Array;
  /** Path on disk. Mutually exclusive with `content`. */
  path?: string;
  contentType?: string;
  /** For embedded images: `<img src="cid:logo">`. */
  cid?: string;
}

// ── Envelope and content ─────────────────────────────────────────────────────

/** The "who" of the email. */
export interface Envelope {
  to: Address | Address[];
  from?: Address;
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  subject: string;
  /** Extra headers (List-Unsubscribe, X-Entity-Ref-ID…). */
  headers?: Record<string, string>;
  /** Tag for metrics/filtering at the provider. */
  tag?: string;
}

/** The "what" of the email. */
export interface Content {
  html?: string;
  /** Plain-text alternative. If missing, it is derived from the HTML. */
  text?: string;
}

// ── Mailable ─────────────────────────────────────────────────────────────────

/**
 * An email, as a reusable and testable unit — the equivalent of Laravel's
 * Mailable.
 *
 * `name` is the key used to assert in tests
 * (`mail.assertSent("welcome")`) and the one a kon registers it under.
 */
export interface Mailable<TData = unknown> {
  /** Stable identifier, unique per app (e.g. "crm.deal-won"). */
  name: string;
  /** Builds the envelope from the data. */
  envelope(data: TData, ctx: MailContext): Envelope;
  /** Builds the body. */
  content(data: TData, ctx: MailContext): Content;
  /** Attachments, if any. */
  attachments?(data: TData, ctx: MailContext): Attachment[];
}

/** Context a Mailable receives when rendered. */
export interface MailContext {
  /** Recipient's language (localization). Default: `defaultLocale`. */
  locale: string;
  /** Translates a key; returns the key if there is no translation. */
  t(key: string, vars?: Record<string, string | number>): string;
  /** Public URL of the app, for absolute links. */
  appUrl: string;
  /** Name of the app, for the layout. */
  appName: string;
}

// ── Already-rendered message ─────────────────────────────────────────────────

/** What finally goes to the driver (and what the outbox sees in tests). */
export interface SentMessage {
  /** Name of the Mailable that originated it (assertion key). */
  mailable: string;
  to: string[];
  from: string;
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments: Attachment[];
  headers: Record<string, string>;
  locale: string;
  tag?: string;
  /** Id returned by the provider (if any). */
  messageId?: string;
  sentAt: string;
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Sending backend — the equivalent of Django's EMAIL_BACKEND.
 *
 * Making it an interface (and not an `if` per provider) is what allows switching
 * SMTP ↔ Resend ↔ log ↔ memory without touching a line of the app, and it is what
 * makes `mail.fake()` possible.
 */
export interface MailDriver {
  readonly name: string;
  send(message: SentMessage): Promise<{ messageId?: string }>;
  /** Optional connectivity check at startup. */
  verify?(): Promise<boolean>;
}
