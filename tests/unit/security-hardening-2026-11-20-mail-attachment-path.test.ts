/**
 * Hardening 2026-11-20: the SMTP driver never fetches an attachment `path` that
 * is a URL. nodemailer reads `http(s)://` paths by downloading them, which would
 * make the API server request any address from inside the network.
 */
import { describe, expect, it } from "vitest";

import { smtpMessage } from "../../packages/engine/src/mail/drivers";
import type { SentMessage } from "../../packages/engine/src/mail/types";

describe("smtpMessage", () => {
  it("turns URL access off for attachments", () => {
    const message = {
      mailable: "invoice",
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      from: "no-reply@example.com",
      subject: "Invoice",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: {},
      attachments: [{ filename: "a.pdf", path: "http://169.254.169.254/latest/meta-data" }],
    } as unknown as SentMessage;

    const options = smtpMessage(message);

    expect(options.disableUrlAccess).toBe(true);
    expect(options.attachments).toEqual([
      expect.objectContaining({
        filename: "a.pdf",
        path: "http://169.254.169.254/latest/meta-data",
      }),
    ]);
  });
});
