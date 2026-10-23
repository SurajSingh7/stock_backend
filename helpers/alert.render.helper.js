import { ALERT_CHANNEL } from "../constants/stock.enums.js";

/*
  Fills a template's {{variables}}.

  Email bodies are HTML, so values are escaped there — a vendor called
  "A & B <Traders>" must not break the mail or inject markup. WhatsApp is
  plain text and gets values as they are. An unknown {{name}} is left in
  place, so a typo shows up in Preview instead of silently vanishing.
*/
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fill = (text, vars, escape) =>
  String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (escape ? escapeHtml(vars[name] ?? "") : String(vars[name] ?? "")) : whole
  );

/** Names used in a text that the event does not provide. */
export const unknownVariables = (text, known) => {
  const names = [...String(text || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(names.filter((n) => !known.includes(n)))];
};

export const renderAlertTemplate = (template, vars) => {
  const isEmail = template.channel === ALERT_CHANNEL.EMAIL;
  let body = fill(template.body, vars, isEmail);
  // Plain line breaks typed into an email body read as one paragraph in HTML.
  if (isEmail && !/<(p|br|div|table)\b/i.test(body)) body = body.replace(/\n/g, "<br>");
  return {
    // Email subject, or the bell's title.
    subject: template.channel === ALERT_CHANNEL.WHATSAPP ? "" : fill(template.subject, vars, false),
    body,
  };
};
