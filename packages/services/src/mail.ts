// Outbound & inbound mail services (Resend HTTP, custom webhook bridge, in-memory test transport,
// mailbox presets, message classification, and localization via @aphrody/auto-i18n).
import { formatEur, type Document } from "@aphrody/auto-domain";
import { t, type Locale } from "@aphrody/auto-i18n";
import type { AuthMailer } from "@aphrody/auto-store/auth";

export interface OutboundMail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; contentType: string; bytes: Uint8Array }[];
}

export interface Mailer {
  send(message: OutboundMail): Promise<{ id: string }>;
}

export interface MailProviderPreset {
  id: "google" | "microsoft" | "ovh" | "infomaniak" | "resend" | "custom";
  name: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export const MAIL_PRESETS: readonly MailProviderPreset[] = [
  {
    id: "google",
    name: "Google Workspace / Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
  },
  {
    id: "microsoft",
    name: "Microsoft 365",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
  },
  { id: "ovh", name: "OVH Mail", imapHost: "ssl0.ovh.net", imapPort: 993, smtpHost: "ssl0.ovh.net", smtpPort: 465 },
  {
    id: "infomaniak",
    name: "Infomaniak",
    imapHost: "mail.infomaniak.com",
    imapPort: 993,
    smtpHost: "mail.infomaniak.com",
    smtpPort: 465,
  },
  { id: "resend", name: "Resend API" },
  { id: "custom", name: "Custom IMAP/SMTP" },
] as const;

export function validEmailAddress(email: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email.trim()) && email.length <= 254;
}

export function createResendMailer(apiKey: string, from: string, fetcher: typeof fetch = fetch): Mailer {
  return {
    async send(message) {
      const toList = Array.isArray(message.to) ? message.to : [message.to];
      const res = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: toList,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.bytes).toString("base64"),
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { id?: string };
      return { id: data.id ?? crypto.randomUUID() };
    },
  };
}

export function createMemoryMailer(): Mailer & { sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { id: `mem_${sent.length}` };
    },
  };
}

export function createMailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer {
  const resendKey = env.RESEND_API_KEY?.trim();
  const from = env.AUTO_MAIL_FROM?.trim() || "Auto <noreply@aphrody.com>";
  if (resendKey) return createResendMailer(resendKey, from);
  return {
    async send(message) {
      return { id: `noop_${crypto.randomUUID().slice(0, 8)}_${String(message.to).length}` };
    },
  };
}

export function asAuthMailer(mailer: Mailer): AuthMailer {
  return {
    async send(msg) {
      await mailer.send(msg);
    },
  };
}

export function formatDocumentEmail(
  doc: Document,
  number: string,
  portalUrl: string,
  locale: Locale = "en",
  totalInclVatCents = 0,
): { subject: string; text: string } {
  const label =
    doc.type === "quote"
      ? t(locale, "Quote")
      : doc.type === "credit_note"
        ? t(locale, "Credit note")
        : t(locale, "Invoice");
  const amount = formatEur(totalInclVatCents, locale);
  const subject = `${label} ${number} — ${doc.issuer.name}`;
  const text = [
    `${t(locale, "Hello")} ${doc.customer.name},`,
    "",
    `${t(locale, "Please find attached your document:")} ${label} ${number} (${amount}).`,
    `${t(locale, "View or pay online:")} ${portalUrl}`,
    "",
    doc.issuer.name,
  ].join("\n");
  return { subject, text };
}

export function classifyInboundEmail(input: {
  subject: string;
  text: string;
  attachments?: { filename: string; mimeType: string }[];
}): "invoice" | "quote_request" | "general" {
  const haystack = `${input.subject}\n${input.text}`.toLowerCase();
  const hasFinancialAttachment = (input.attachments ?? []).some(
    (a) => a.mimeType.includes("pdf") || a.mimeType.includes("xml") || /\.(pdf|xml)$/i.test(a.filename),
  );
  if (hasFinancialAttachment && /(invoice|facture|avoir|credit note|statement)/i.test(haystack)) {
    return "invoice";
  }
  if (/(quote|quotation|devis|estimate|proposal|rfq)/i.test(haystack)) {
    return "quote_request";
  }
  return hasFinancialAttachment ? "invoice" : "general";
}
