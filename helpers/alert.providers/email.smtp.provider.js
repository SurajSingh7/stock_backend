import { sendMail, isMailConfigured } from "../mail.helper.js";

/*
  Email over SMTP (nodemailer, configured in mail.helper.js).

  SMTP answers "accepted" or an error and nothing after that, so a sent email
  is SENT and stays SENT — there is no delivered/read for this channel.
*/
const emailSmtpProvider = {
  name: "smtp",

  status() {
    return isMailConfigured()
      ? { configured: true, connected: true, detail: "SMTP configured" }
      : { configured: false, connected: false, detail: "Set SMTP_HOST / SMTP_USER / SMTP_PASS in .env" };
  },

  async send(message) {
    if (!isMailConfigured()) {
      throw Object.assign(new Error("SMTP is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env"), {
        permanent: true,
      });
    }
    const info = await sendMail({
      to: message.to.address,
      cc: message.cc,
      subject: message.subject,
      html: message.body,
      attachments: (message.attachments || []).map((a) => ({ filename: a.fileName, path: a.path })),
    });
    return { providerMessageId: info?.messageId || "", status: "SENT" };
  },
};

export default emailSmtpProvider;
