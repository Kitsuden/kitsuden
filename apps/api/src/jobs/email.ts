/**
 * Kitsuden — Email worker
 * ============================================================================
 *
 * Consumes the `kitsuden-email` queue (Postgres, lib/queue.ts) and delegates to the
 * engine's Mailer. "At least once" delivery: if the process dies between
 * sending and closing the job, the email may go out twice.
 *
 * BEFORE: this file had the inline HTML templates, the SMTP config and the
 * sending logic — 183 lines that no kon could extend.
 * NOW: it is only the queue → Mailer bridge. Emails are registered
 * Mailables (`apps/api/src/mail/system-mails.ts`), the driver is
 * swappable (smtp/resend/log/memory) and kons register their own.
 *
 * The job name IS the Mailable name, so queueing a new email does not
 * require touching this file:
 *
 *   await emailQueue.add("system.welcome", { to, name });
 *   await emailQueue.add("crm.deal-won", { to, dealId });   // from a kon
 */

// DELIBERATE and safe email↔queue cycle: queue.ts loads us with a lazy
// `await import()` at runtime (registerEmailWorker), so the edge
// back does not exist at static load time and nothing is left half-initialized.
//
// The warning lands here, on the facade, and not on the `../lib/queue` import: the
// path that closes the circle enters through the engine's index. That is why the
// exception goes on this line.

import { mail } from "../../../../packages/engine/src/mail";
import { PermanentError, queue, type QueueJob } from "../../../../packages/engine/src/queue";
import { EMAIL_QUEUE } from "../lib/queue";

/**
 * Payload of an email job. `to` is the only required field; the rest is
 * consumed by the corresponding Mailable.
 */
interface MailJobData extends Record<string, unknown> {
  to?: string;
  /** Recipient's language; if missing, the Mailer's default is used. */
  locale?: string;
}

export async function processEmailJob(job: QueueJob) {
  const data = (job.payload ?? {}) as MailJobData;

  // The job name identifies the Mailable.
  if (mail.has(job.name)) {
    const result = await mail.send(job.name, data, data.locale);

    if (!result.ok) {
      // It is rethrown so the queue applies its retry policy: a
      // network failure when sending SHOULD be retried.
      throw new Error(result.error ?? `Could not send "${job.name}"`);
    }

    console.log(
      `  📧 [${mail.driverName}] ${job.name} → ${result.message.to.join(", ")} (${result.messageId ?? "no id"})`
    );
    return { sent: true, messageId: result.messageId };
  }

  // Compatibility: jobs with loose subject/html/text (no Mailable).
  const { to, subject, html, text } = data as {
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
  };

  if (!to || !subject) {
    // Retrying will not fix it: to the "dead letter", visible in the panel.
    throw new PermanentError(`Email job "${job.name}" has no registered Mailable or subject`);
  }

  // An anonymous Mailable is registered on the fly to reuse the driver and logging.
  const adHoc = `adhoc:${job.name}`;
  if (!mail.has(adHoc)) {
    mail.register({
      name: adHoc,
      envelope: (d: any) => ({ to: d.to, subject: d.subject }),
      content: (d: any) => ({ html: d.html ?? "", text: d.text }),
    });
  }

  const result = await mail.send(adHoc, { to, subject, html, text }, data.locale);
  if (!result.ok) throw new Error(result.error ?? "Failed to send");
  return { sent: true, messageId: result.messageId };
}

/** Starts the email queue worker. */
export function registerEmailWorker() {
  console.log(`  📧 Email Worker: driver "${mail.driverName}" · ${mail.list().length} mailables`);

  if (mail.driverName === "log") {
    console.log(
      "     ℹ️  No credentials: emails are printed to the console. " +
        "Set RESEND_API_KEY or SMTP_HOST to actually send them."
    );
  }

  queue.handle(EMAIL_QUEUE, processEmailJob, { concurrency: 2 });
}
