/**
 * Kitsuden — Mail
 * ============================================================================
 * Mail system with Mailables (Laravel), interchangeable drivers and a test
 * outbox (Django), shared layout and localization.
 *
 * PURE engine module: it does not import the DB, the host or infrastructure, so
 * a kon can define and register its emails without coupling to apps/api.
 */

export {
  formatAddress,
  addressEmail,
  type Address,
  type Attachment,
  type Envelope,
  type Content,
  type Mailable,
  type MailContext,
  type SentMessage,
  type MailDriver,
} from "./types";

export {
  logDriver,
  memoryDriver,
  smtpDriver,
  resendDriver,
  driverFromEnv,
  type MemoryDriver,
  type SmtpOptions,
  type ResendOptions,
} from "./drivers";

export {
  layout,
  heading,
  paragraph,
  button,
  panel,
  code,
  table,
  esc,
  htmlToText,
  type LayoutOptions,
} from "./templates";

export { Mailer, mail, type MailerOptions, type SendResult } from "./mailer";
