/**
 * Kitsuden — System emails
 * ============================================================================
 *
 * The Mailables that the core ships (welcome, recovery). They used to live as
 * duplicated inline HTML inside `jobs/email.ts`; now they compose the shared
 * layout and their texts go through `ctx.t()`, so they are localized.
 *
 * A kon registers its own the same way — see `registerSystemMails` at the end.
 */

import {
  button,
  heading,
  layout,
  panel,
  paragraph,
  type Mailable,
  type Mailer,
} from "@kitsuden/engine";

// ── Welcome ──────────────────────────────────────────────────────────────────

export interface WelcomeData {
  to: string;
  name?: string;
}

export const welcomeMail: Mailable<WelcomeData> = {
  name: "system.welcome",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("mail.welcome.subject", { app: ctx.appName }),
    tag: "welcome",
  }),

  content: (data, ctx) => ({
    html: layout({
      appName: ctx.appName,
      preheader: ctx.t("mail.welcome.preheader"),
      body:
        heading(ctx.t("mail.welcome.heading", { name: data.name ?? "Admin" })) +
        paragraph(ctx.t("mail.welcome.intro", { app: ctx.appName })) +
        paragraph(ctx.t("mail.welcome.cta_hint")) +
        button(ctx.t("mail.welcome.cta"), `${ctx.appUrl}/admin`),
    }),
  }),
};

// ── Password recovery ────────────────────────────────────────────────────────

export interface RecoveryData {
  to: string;
  resetUrl: string;
  /** Minutes of validity of the link. */
  expiresIn?: number;
}

export const recoveryMail: Mailable<RecoveryData> = {
  name: "system.password-recovery",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("mail.recovery.subject", { app: ctx.appName }),
    tag: "recovery",
    headers: {
      // A transactional email must never be grouped into threads with others.
      "X-Entity-Ref-ID": `recovery-${Date.now()}`,
    },
  }),

  content: (data, ctx) => ({
    html: layout({
      appName: ctx.appName,
      preheader: ctx.t("mail.recovery.preheader"),
      body:
        heading(ctx.t("mail.recovery.heading")) +
        paragraph(ctx.t("mail.recovery.intro")) +
        button(ctx.t("mail.recovery.cta"), data.resetUrl) +
        panel(ctx.t("mail.recovery.expiry", { minutes: data.expiresIn ?? 60 })) +
        paragraph(ctx.t("mail.recovery.ignore")),
    }),
  }),
};

// ── Email verification ───────────────────────────────────────────────────────
//
// It did not exist. Sign-up with email and password did not check that the email belonged
// to the person registering: anyone could create an account with someone
// else's address and sign in with it. The recovery template did exist, but
// nothing sent it — the same problem from the other side.

export interface VerificationData {
  to: string;
  verifyUrl: string;
  name?: string;
  /** Minutes of validity of the link. */
  expiresIn?: number;
}

export const verificationMail: Mailable<VerificationData> = {
  name: "system.email-verification",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("mail.verify.subject", { app: ctx.appName }),
    tag: "verification",
    headers: {
      // Same as recovery: transactional, never grouped into a thread.
      "X-Entity-Ref-ID": `verify-${Date.now()}`,
    },
  }),

  content: (data, ctx) => ({
    html: layout({
      appName: ctx.appName,
      preheader: ctx.t("mail.verify.preheader"),
      body:
        heading(ctx.t("mail.verify.heading")) +
        paragraph(ctx.t("mail.verify.intro", { app: ctx.appName })) +
        button(ctx.t("mail.verify.cta"), data.verifyUrl) +
        panel(ctx.t("mail.verify.expiry", { minutes: data.expiresIn ?? 60 })) +
        paragraph(ctx.t("mail.verify.ignore")),
    }),
  }),
};

// ── Magic link ───────────────────────────────────────────────────────────────
//
// Sign-in without a password (better-auth `magicLink`, see lib/auth.ts). The
// link signs in whoever holds it, so it is short-lived and single-use; accounts
// with two-factor sign-in never get one (a link is a single factor).

export interface MagicLinkData {
  to: string;
  url: string;
  /** Minutes of validity of the link. */
  expiresIn?: number;
}

export const magicLinkMail: Mailable<MagicLinkData> = {
  name: "system.magic-link",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("mail.magic.subject", { app: ctx.appName }),
    tag: "magic-link",
    headers: {
      // Transactional, never grouped into a thread.
      "X-Entity-Ref-ID": `magic-${Date.now()}`,
    },
  }),

  content: (data, ctx) => ({
    html: layout({
      appName: ctx.appName,
      preheader: ctx.t("mail.magic.preheader"),
      body:
        heading(ctx.t("mail.magic.heading")) +
        paragraph(ctx.t("mail.magic.intro", { app: ctx.appName })) +
        button(ctx.t("mail.magic.cta"), data.url) +
        panel(ctx.t("mail.magic.expiry", { minutes: data.expiresIn ?? 10 })) +
        paragraph(ctx.t("mail.magic.ignore")),
    }),
  }),
};

// ── Translations ─────────────────────────────────────────────────────────────

const EN: Record<string, string> = {
  "mail.welcome.subject": "Welcome to {app}",
  "mail.welcome.preheader": "Your instance is ready.",
  "mail.welcome.heading": "Welcome aboard, {name}",
  "mail.welcome.intro": "Your {app} instance is ready and you're set up as Super Admin.",
  "mail.welcome.cta_hint": "Head to the admin panel to start building:",
  "mail.welcome.cta": "Open admin panel",
  "mail.recovery.subject": "{app} — Password reset",
  "mail.recovery.preheader": "Reset your password.",
  "mail.recovery.heading": "Password reset",
  "mail.recovery.intro":
    "We received a request to reset your password. Click below to set a new one:",
  "mail.recovery.cta": "Reset password",
  "mail.recovery.expiry": "This link expires in {minutes} minutes.",
  "mail.recovery.ignore": "If you didn't request this, you can safely ignore this email.",
  "mail.verify.subject": "{app} — Confirm your email",
  "mail.verify.preheader": "Confirm your email address.",
  "mail.verify.heading": "Confirm your email",
  "mail.verify.intro": "Click below to confirm this email address for your {app} account:",
  "mail.verify.cta": "Confirm email",
  "mail.verify.expiry": "This link expires in {minutes} minutes.",
  "mail.verify.ignore": "If you didn't create an account, you can safely ignore this email.",
  "mail.magic.subject": "{app} — Your sign-in link",
  "mail.magic.preheader": "Sign in without a password.",
  "mail.magic.heading": "Sign in",
  "mail.magic.intro": "Click below to sign in to {app}. The link works once:",
  "mail.magic.cta": "Sign in",
  "mail.magic.expiry": "This link expires in {minutes} minutes.",
  "mail.magic.ignore": "If you didn't ask to sign in, you can safely ignore this email.",
};

const ES: Record<string, string> = {
  "mail.welcome.subject": "Bienvenido a {app}",
  "mail.welcome.preheader": "Tu instancia está lista.",
  "mail.welcome.heading": "Bienvenido, {name}",
  "mail.welcome.intro": "Tu instancia de {app} está lista y tienes rol de Super Admin.",
  "mail.welcome.cta_hint": "Entra al panel para empezar a construir:",
  "mail.welcome.cta": "Abrir el panel",
  "mail.recovery.subject": "{app} — Recuperar contraseña",
  "mail.recovery.preheader": "Restablece tu contraseña.",
  "mail.recovery.heading": "Restablecer contraseña",
  "mail.recovery.intro":
    "Recibimos una solicitud para restablecer tu contraseña. Pulsa el botón para elegir una nueva:",
  "mail.recovery.cta": "Restablecer contraseña",
  "mail.recovery.expiry": "Este enlace caduca en {minutes} minutos.",
  "mail.recovery.ignore": "Si no lo solicitaste, puedes ignorar este correo.",
  "mail.verify.subject": "{app} — Confirma tu email",
  "mail.verify.preheader": "Confirma tu dirección de correo.",
  "mail.verify.heading": "Confirma tu email",
  "mail.verify.intro": "Pulsa el botón para confirmar esta dirección en tu cuenta de {app}:",
  "mail.verify.cta": "Confirmar email",
  "mail.verify.expiry": "Este enlace caduca en {minutes} minutos.",
  "mail.verify.ignore": "Si no creaste una cuenta, puedes ignorar este correo.",
  "mail.magic.subject": "{app} — Tu enlace para entrar",
  "mail.magic.preheader": "Entra sin contraseña.",
  "mail.magic.heading": "Entrar",
  "mail.magic.intro": "Pulsa el botón para entrar en {app}. El enlace sirve una sola vez:",
  "mail.magic.cta": "Entrar",
  "mail.magic.expiry": "Este enlace caduca en {minutes} minutos.",
  "mail.magic.ignore": "Si no pediste entrar, puedes ignorar este correo.",
};

/**
 * Registers the system emails and their translations.
 * Called once at startup; it is idempotent.
 */
export function registerSystemMails(mailer: Mailer): void {
  mailer
    .registerAll([welcomeMail, recoveryMail, verificationMail, magicLinkMail])
    .addTranslations("en", EN)
    .addTranslations("es", ES);
}
