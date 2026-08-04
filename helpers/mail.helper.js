// Email transport for the PO "Send Mail" action.
//
// Required .env vars (none of these exist yet in this repo — add them to
// stock-backend's .env before real sending will work):
//   SMTP_HOST      e.g. smtp.gmail.com / smtp.sendgrid.net
//   SMTP_PORT      e.g. 587 (STARTTLS) or 465 (implicit TLS)
//   SMTP_USER      SMTP auth username
//   SMTP_PASS      SMTP auth password / API key
//   SMTP_SECURE    "true" for port 465, "false" for 587/25
//   MAIL_FROM_DEFAULT  fallback From address when nothing else resolves
//
// Until these are set, sendMail() throws a clear, catchable error rather
// than silently no-op'ing — the PO "Send Mail" flow surfaces that error to
// the user instead of pretending the email went out.

import nodemailer from "nodemailer";

let transporter = null;

// .env values are taken verbatim by dotenv (including any stray trailing
// whitespace from a copy-pasted password/host) — trim defensively so a
// trailing space doesn't silently break SMTP auth.
const env = (key) => (process.env[key] || "").trim();

const isConfigured = () => Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));

const getTransporter = () => {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env("SMTP_HOST"),
      port: Number(env("SMTP_PORT")) || 587,
      secure: env("SMTP_SECURE").toLowerCase() === "true",
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
  }
  return transporter;
};

export const sendMail = async ({ from, to, cc, subject, html, attachments }) => {
  const t = getTransporter();
  if (!t) throw new Error("SMTP is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env");

  return t.sendMail({
    from: from || env("MAIL_FROM_DEFAULT"),
    to,
    cc: cc && cc.length ? cc.join(",") : undefined,
    subject,
    html,
    attachments,
  });
};
