import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

type CompanyRow = {
  id: string;
  name: string | null;
};

type TemplateRow = {
  body_template: string;
  cc_recipients: string[] | null;
  custom_cc_emails: string[] | null;
  custom_to_emails: string[] | null;
  is_enabled: boolean;
  subject_template: string;
  to_recipients: string[] | null;
};

type BusinessDocumentRow = {
  id: string;
  document_type_code: string;
  expiry_date: string | null;
  reference_no: string | null;
  scope_id: string | null;
  scope_label: string | null;
  scope_type: string;
  track_expiry: boolean | null;
  document_types?: { name: string | null } | { name: string | null }[] | null;
};

type StationRow = {
  id: string;
  station_email: string | null;
  station_manager_email: string | null;
};

type Reminder = {
  key: string;
  line: string;
  stage: string;
};

type RecipientMap = {
  compliance_manager: string | null;
  location_email: string | null;
  location_manager: string | null;
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function todayInKolkata() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateToUtcMs(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysUntil(expiryDate: string | null, today: string) {
  if (!expiryDate) return null;
  const expiryMs = dateToUtcMs(expiryDate);
  const todayMs = dateToUtcMs(today);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(todayMs)) return null;
  return Math.round((expiryMs - todayMs) / 86400000);
}

function reminderFor(days: number | null): Reminder | null {
  if (days === null) return null;
  if ([30, 15, 7, 1].includes(days)) {
    return {
      key: `before_${days}`,
      stage: `Expires in ${days} day${days === 1 ? "" : "s"}`,
      line: `Days Left: ${days} day${days === 1 ? "" : "s"}`
    };
  }
  if (days === 0) {
    return { key: "expires_today", stage: "Expires today", line: "Status: Expires today" };
  }
  if (days < 0 && Math.abs(days) % 7 === 0) {
    const expiredDays = Math.abs(days);
    return {
      key: `expired_${expiredDays}`,
      stage: `Expired ${expiredDays} days ago`,
      line: `Expired: ${expiredDays} days ago`
    };
  }
  return null;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function cleanEmail(value: string | null | undefined) {
  const text = String(value ?? "").trim().toLowerCase();
  return text && text.includes("@") ? text : null;
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

function scopeCode(document: BusinessDocumentRow) {
  if (document.scope_type === "company") return "COMPANY";
  if (document.scope_type === "state") return String(document.scope_id ?? document.scope_label ?? "").trim().toUpperCase();
  return String(document.scope_label || document.scope_id || "-").split(" - ")[0].trim();
}

async function recipientMapFor(companyId: string, document: BusinessDocumentRow, complianceManagerEmail: string | null): Promise<RecipientMap> {
  const result: RecipientMap = {
    compliance_manager: cleanEmail(complianceManagerEmail),
    location_email: null,
    location_manager: null
  };

  if (document.scope_type === "location" && document.scope_id && supabaseAdmin) {
    const station = await supabaseAdmin
      .from("stations")
      .select("id, station_email, station_manager_email")
      .eq("company_id", companyId)
      .eq("id", document.scope_id)
      .maybeSingle();
    const data = station.data as StationRow | null;
    result.location_email = cleanEmail(data?.station_email);
    result.location_manager = cleanEmail(data?.station_manager_email);
  }

  return result;
}

function selectedRecipients(map: RecipientMap, selected: string[] | null | undefined) {
  const emails = new Set<string>();
  for (const key of selected ?? []) {
    const email = map[key as keyof RecipientMap];
    if (email) emails.add(email);
  }
  return Array.from(emails);
}

async function processCompany(company: CompanyRow, today: string) {
  if (!supabaseAdmin) return { failed: 0, sent: 0, skipped: 0 };
  const [templateResult, settingsResult, documentsResult] = await Promise.all([
    supabaseAdmin
      .from("business_document_notification_templates")
      .select("is_enabled, to_recipients, cc_recipients, custom_to_emails, custom_cc_emails, subject_template, body_template")
      .eq("company_id", company.id)
      .eq("id", true)
      .maybeSingle(),
    supabaseAdmin
      .from("business_document_settings")
      .select("compliance_manager_user_id, profiles (email)")
      .eq("company_id", company.id)
      .eq("id", true)
      .maybeSingle(),
    supabaseAdmin
      .from("business_document_records")
      .select("id, document_type_code, scope_type, scope_id, scope_label, reference_no, expiry_date, track_expiry, document_types (name)")
      .eq("company_id", company.id)
      .eq("is_active", true)
      .eq("track_expiry", true)
      .not("expiry_date", "is", null)
  ]);

  if (templateResult.error || settingsResult.error || documentsResult.error) {
    return { failed: 1, sent: 0, skipped: 0 };
  }

  const template = templateResult.data as TemplateRow | null;
  if (!template?.is_enabled) return { failed: 0, sent: 0, skipped: 0 };

  const settings = settingsResult.data as { profiles?: { email: string | null } | { email: string | null }[] | null } | null;
  const complianceManagerEmail = firstRelation(settings?.profiles)?.email ?? null;

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const document of (documentsResult.data ?? []) as unknown as BusinessDocumentRow[]) {
    const days = daysUntil(document.expiry_date, today);
    const reminder = reminderFor(days);
    if (!reminder) continue;

    const existing = await supabaseAdmin
      .from("business_document_notification_logs")
      .select("id")
      .eq("company_id", company.id)
      .eq("business_document_record_id", document.id)
      .eq("reminder_key", reminder.key)
      .eq("sent_on", today)
      .limit(1);
    if (existing.data?.length) {
      skipped += 1;
      continue;
    }

    const priorSend = await supabaseAdmin
      .from("business_document_notification_logs")
      .select("message_id, root_message_id")
      .eq("company_id", company.id)
      .eq("business_document_record_id", document.id)
      .eq("status", "sent")
      .not("message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMessageId = priorSend.data?.message_id ?? null;
    const rootMessageId = priorSend.data?.root_message_id ?? lastMessageId;

    const recipientMap = await recipientMapFor(company.id, document, complianceManagerEmail);
    const toRecipients = selectedRecipients(
      recipientMap,
      template.to_recipients?.length ? template.to_recipients : ["compliance_manager", "location_email", "location_manager"]
    );
    for (const email of template.custom_to_emails ?? []) {
      const clean = cleanEmail(email);
      if (clean && !toRecipients.includes(clean)) toRecipients.push(clean);
    }
    const ccRecipients = selectedRecipients(recipientMap, template.cc_recipients);
    for (const email of template.custom_cc_emails ?? []) {
      const clean = cleanEmail(email);
      if (clean && !ccRecipients.includes(clean)) ccRecipients.push(clean);
    }
    const finalCcRecipients = ccRecipients.filter((email) => !toRecipients.includes(email));
    const documentType = firstRelation(document.document_types);
    const values = {
      company_name: company.name ?? "DropX",
      document_name: documentType?.name || document.document_type_code,
      expired_days: days !== null && days < 0 ? String(Math.abs(days)) : "",
      expiry_date: formatDate(document.expiry_date),
      days_left: days !== null && days >= 0 ? String(days) : "",
      reference_no: document.reference_no ?? "-",
      reminder_line: reminder.line,
      reminder_stage: reminder.stage,
      scope_code: scopeCode(document)
    };
    const subject = renderTemplate(template.subject_template, values);
    const body = renderTemplate(template.body_template, values);

    try {
      if (!toRecipients.length) throw new Error("No recipients found.");
      const threadMessageId = `<dropx.business-document.${document.id}.${reminder.key}@partner.dropxlogistics.com>`;
      const result = await sendEmail({
        body, cc: finalCcRecipients, companyId: company.id, subject, to: toRecipients,
        messageId: threadMessageId,
        inReplyTo: lastMessageId ?? undefined,
        references: lastMessageId ? [...new Set([rootMessageId, lastMessageId].filter((id): id is string => Boolean(id)))] : undefined
      });
      await supabaseAdmin.from("business_document_notification_logs").insert({
        company_id: company.id,
        business_document_record_id: document.id,
        reminder_key: reminder.key,
        sent_on: today,
        recipients: toRecipients,
        cc_recipients: finalCcRecipients,
        subject,
        status: "sent",
        message_id: result.messageId ?? threadMessageId,
        root_message_id: rootMessageId ?? result.messageId ?? threadMessageId
      });
      sent += 1;
    } catch (error) {
      await supabaseAdmin.from("business_document_notification_logs").insert({
        company_id: company.id,
        business_document_record_id: document.id,
        reminder_key: reminder.key,
        sent_on: today,
        recipients: toRecipients,
        cc_recipients: finalCcRecipients,
        subject,
        status: "failed",
        error_message: error instanceof Error ? error.message : "Unable to send email."
      });
      failed += 1;
    }
  }

  return { failed, sent, skipped };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const today = todayInKolkata();
  const companiesResult = await supabaseAdmin.from("companies").select("id, name").eq("is_active", true);
  if (companiesResult.error) return NextResponse.json({ error: companiesResult.error.message }, { status: 500 });

  const totals = { failed: 0, sent: 0, skipped: 0 };
  for (const company of (companiesResult.data ?? []) as CompanyRow[]) {
    const result = await processCompany(company, today);
    totals.failed += result.failed;
    totals.sent += result.sent;
    totals.skipped += result.skipped;
  }

  return NextResponse.json({ date: today, ...totals });
}
