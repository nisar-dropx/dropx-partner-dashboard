import nodemailer from "nodemailer";
import { supabaseAdmin } from "@/lib/supabase-admin";

type SendEmailParams = {
  body: string;
  cc?: string[];
  companyId?: string;
  subject: string;
  to: string[];
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
};

type EmailConfig = {
  from: string;
  host: string;
  pass: string | null;
  port: number;
  secure: boolean;
  user: string | null;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function formatFromAddress(from: string, fromName?: string | null) {
  const name = String(fromName ?? "").trim();
  if (!name) return from;
  return `"${name.replace(/"/g, '\\"')}" <${from}>`;
}

async function loadDbEmailConfig(companyId?: string): Promise<EmailConfig | null> {
  if (!companyId || !supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("email_notification_settings")
    .select("is_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from, from_name")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("email_notification_settings") && (message.includes("does not exist") || message.includes("schema cache"))) return null;
    throw new Error(error.message);
  }
  if (!data?.is_enabled || !data.smtp_host) return null;
  const from = String(data.smtp_from || data.smtp_user || "").trim();
  if (!from) throw new Error("Email Config from address is not configured.");
  return {
    from: formatFromAddress(from, data.from_name),
    host: data.smtp_host,
    pass: data.smtp_pass || null,
    port: Number(data.smtp_port ?? 587),
    secure: Boolean(data.smtp_secure),
    user: data.smtp_user || null
  };
}

function loadEnvEmailConfig(): EmailConfig {
  const host = requiredEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER?.trim() || null;
  const pass = process.env.SMTP_PASS?.trim() || null;
  const from = process.env.SMTP_FROM?.trim() || process.env.EMAIL_FROM?.trim() || user;
  if (!from) throw new Error("SMTP_FROM or EMAIL_FROM is not configured.");
  return {
    from,
    host,
    pass,
    port,
    secure: String(process.env.SMTP_SECURE ?? "").toLowerCase() === "true" || port === 465,
    user
  };
}

export async function sendEmail({ body, cc = [], companyId, subject, to, html, messageId, inReplyTo, references }: SendEmailParams) {
  const recipients = Array.from(new Set(to.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const ccRecipients = Array.from(new Set(cc.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (!recipients.length) throw new Error("No email recipients found.");

  const config = await loadDbEmailConfig(companyId) ?? loadEnvEmailConfig();

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465 || (config.secure && config.port !== 587),
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
  });

  const result = await transporter.sendMail({
    from: config.from,
    to: recipients,
    cc: ccRecipients.length ? ccRecipients : undefined,
    subject,
    text: body,
    html,
    messageId,
    inReplyTo,
    references
  });
  return { messageId: result.messageId, response: result.response };
}
