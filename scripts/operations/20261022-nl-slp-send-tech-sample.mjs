/**
 * One-off verification sample of the loss-recovery digest to tech@.
 * Does not touch portal_digest_runs (so the real 09:00 cron can still send).
 *
 * Usage: node scripts/operations/20261022-nl-slp-send-tech-sample.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import {
  lossRecoveryDigestSubject,
  renderLossRecoveryDigestEmail,
} from "../../src/lib/loss-recovery-action-digest-render.ts";

function loadEnv() {
  const out = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (out[m[1]] == null || out[m[1]] === "") out[m[1]] = v;
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const TO = "tech@dropxlogistics.com";
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const control = await db
  .from("portal_notification_controls")
  .select("state,config,subject_template")
  .eq("company_id", COMPANY)
  .eq("portal", "ops")
  .eq("event_key", "loss_recovery_action_digest")
  .maybeSingle();
if (control.error) throw new Error(control.error.message);
if (!control.data) throw new Error("Digest control missing");

const smtp = await db
  .from("email_notification_settings")
  .select("is_enabled,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,smtp_from,from_name")
  .eq("company_id", COMPANY)
  .eq("id", true)
  .maybeSingle();
if (smtp.error) throw new Error(smtp.error.message);
if (!smtp.data?.is_enabled || !smtp.data.smtp_host || !smtp.data.smtp_from || !smtp.data.smtp_pass) {
  throw new Error("Company SMTP is not enabled/complete.");
}

const items = await db.rpc("nl_loss_recovery_action_items", { p_company: COMPANY });
if (items.error) throw new Error(items.error.message);
const rows = (items.data ?? []).slice(0, 8);
if (!rows.length) throw new Error("No open actions to sample.");

const rendered = renderLossRecoveryDigestEmail({
  date: DATE,
  recipientName: "Tech",
  rows,
});
const subjectBase = lossRecoveryDigestSubject(
  control.data.subject_template || "DropX · Loss recovery actions · {{date}}",
  DATE,
);
const subject = `[VERIFY SAMPLE] ${subjectBase}`;
const banner = `<div style="padding:12px 20px;background:#fff7ed;border-bottom:1px solid #fed7aa;font:13px Arial"><b>Verification sample for tech@</b> · Control state=<b>${control.data.state}</b> · delivery_ready=<b>${String(control.data.config?.delivery_ready)}</b> · This is not the scheduled 09:00 digest fan-out.</div>`;
const html = rendered.html.replace("<body", `<body`).replace(
  '<table role="presentation" width="100%">',
  `${banner}<table role="presentation" width="100%">`,
);
const text = `VERIFY SAMPLE — loss recovery digest\nControl: ${control.data.state} / delivery_ready=${control.data.config?.delivery_ready}\n\n${rendered.text}`;

const port = Number(smtp.data.smtp_port);
const transport = nodemailer.createTransport({
  host: smtp.data.smtp_host,
  port,
  secure: port === 465 || (Boolean(smtp.data.smtp_secure) && port !== 587),
  auth: { user: smtp.data.smtp_user, pass: smtp.data.smtp_pass },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  disableFileAccess: true,
  disableUrlAccess: true,
});

try {
  const receipt = await transport.sendMail({
    from: `"${String(smtp.data.from_name || "DropX Logistics").replace(/["\r\n]/g, "")}" <${smtp.data.smtp_from}>`,
    to: [TO],
    subject,
    html,
    text,
  });
  if (!receipt.accepted?.includes(TO)) {
    throw new Error(`SMTP did not accept ${TO}: ${JSON.stringify(receipt.accepted)}`);
  }
  console.log(JSON.stringify({
    event: "loss_recovery_digest_verify_sample_sent",
    to: TO,
    subject,
    messageId: receipt.messageId,
    response: receipt.response,
    control: {
      state: control.data.state,
      delivery_ready: control.data.config?.delivery_ready,
      schedule_time: control.data.config?.schedule_time,
    },
    sampleRows: rows.length,
  }, null, 2));
} finally {
  transport.close();
}
