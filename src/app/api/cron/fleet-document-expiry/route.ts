import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

type CompanyRow = { id: string; name: string | null };
type TemplateRow = {
  body_template: string;
  cc_recipients: string[] | null;
  custom_cc_emails: string[] | null;
  custom_to_emails: string[] | null;
  is_enabled: boolean;
  subject_template: string;
  to_recipients: string[] | null;
};
type FleetDocumentRow = {
  id: string;
  document_type: string;
  expiry_date: string | null;
  vehicle_no: string;
};
type FleetVehicleRow = {
  station_code: string | null;
  vehicle_no: string;
};
type StationRow = {
  station_code: string;
  station_email: string | null;
  station_manager_email: string | null;
};
type RecipientMap = {
  fleet_manager: string | null;
  location_email: string | null;
  location_manager: string | null;
};
type Reminder = { key: string; line: string; stage: string };

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
  if (!expiryDate || !/^\d{4}-\d{2}-\d{2}/.test(expiryDate)) return null;
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
  if (days === 0) return { key: "expires_today", stage: "Expires today", line: "Status: Expires today" };
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

function cleanEmail(value: string | null | undefined) {
  const text = String(value ?? "").trim().toLowerCase();
  return text && text.includes("@") ? text : null;
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

function selectedRecipients(map: RecipientMap, selected: string[] | null | undefined) {
  const emails = new Set<string>();
  for (const key of selected ?? []) {
    const email = map[key as keyof RecipientMap];
    if (email) emails.add(email);
  }
  return Array.from(emails);
}

async function loadFleetManagerEmail(companyId: string) {
  if (!supabaseAdmin) return null;
  const settings = await supabaseAdmin
    .from("business_document_settings")
    .select("fleet_manager_user_id")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  const userId = settings.data?.fleet_manager_user_id;
  if (settings.error || !userId) return null;
  const user = await supabaseAdmin
    .from("profiles")
    .select("email")
    .eq("company_id", companyId)
    .eq("id", userId)
    .maybeSingle();
  return cleanEmail(user.data?.email);
}

async function processCompany(company: CompanyRow, today: string) {
  if (!supabaseAdmin) return { failed: 0, sent: 0, skipped: 0 };
  const [templateResult, documentsResult, vehiclesResult, stationsResult, documentTypesResult] = await Promise.all([
    supabaseAdmin
      .from("fleet_document_notification_templates")
      .select("is_enabled, to_recipients, cc_recipients, custom_to_emails, custom_cc_emails, subject_template, body_template")
      .eq("company_id", company.id)
      .eq("id", true)
      .maybeSingle(),
    supabaseAdmin
      .from("fleet_vehicle_documents")
      .select("id, vehicle_no, document_type, expiry_date")
      .eq("company_id", company.id)
      .eq("is_active", true)
      .not("expiry_date", "is", null),
    supabaseAdmin
      .from("fleet_vehicles")
      .select("vehicle_no, station_code")
      .eq("company_id", company.id),
    supabaseAdmin
      .from("stations")
      .select("station_code, station_email, station_manager_email")
      .eq("company_id", company.id),
    supabaseAdmin
      .from("document_types")
      .select("code, name, requires_expiry")
      .eq("company_id", company.id)
      .eq("document_module", "fleet")
      .eq("is_active", true)
  ]);
  if (templateResult.error || documentsResult.error || vehiclesResult.error || stationsResult.error || documentTypesResult.error) {
    return { failed: 1, sent: 0, skipped: 0 };
  }

  const template = templateResult.data as TemplateRow | null;
  if (!template?.is_enabled) return { failed: 0, sent: 0, skipped: 0 };

  const fleetManagerEmail = await loadFleetManagerEmail(company.id);
  const vehicles = new Map(((vehiclesResult.data ?? []) as FleetVehicleRow[]).map((row) => [row.vehicle_no, row]));
  const stations = new Map(((stationsResult.data ?? []) as StationRow[]).map((row) => [row.station_code, row]));
  const documentTypes = new Map((documentTypesResult.data ?? []).map((row) => [String(row.code).toUpperCase(), row]));

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const document of (documentsResult.data ?? []) as FleetDocumentRow[]) {
    const documentType = documentTypes.get(String(document.document_type).toUpperCase());
    if (documentType && documentType.requires_expiry === false) continue;
    const days = daysUntil(document.expiry_date, today);
    const reminder = reminderFor(days);
    if (!reminder) continue;

    const existing = await supabaseAdmin
      .from("fleet_document_notification_logs")
      .select("id")
      .eq("company_id", company.id)
      .eq("fleet_vehicle_document_id", document.id)
      .eq("reminder_key", reminder.key)
      .eq("sent_on", today)
      .limit(1);
    if (existing.data?.length) {
      skipped += 1;
      continue;
    }

    const priorSend = await supabaseAdmin
      .from("fleet_document_notification_logs")
      .select("message_id, root_message_id")
      .eq("company_id", company.id)
      .eq("fleet_vehicle_document_id", document.id)
      .eq("status", "sent")
      .not("message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMessageId = priorSend.data?.message_id ?? null;
    const rootMessageId = priorSend.data?.root_message_id ?? lastMessageId;

    const vehicle = vehicles.get(document.vehicle_no);
    const station = vehicle?.station_code ? stations.get(vehicle.station_code) : null;
    const recipientMap: RecipientMap = {
      fleet_manager: fleetManagerEmail,
      location_email: cleanEmail(station?.station_email),
      location_manager: cleanEmail(station?.station_manager_email)
    };
    const toRecipients = selectedRecipients(
      recipientMap,
      template.to_recipients?.length ? template.to_recipients : ["fleet_manager", "location_email", "location_manager"]
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
    const values = {
      company_name: company.name ?? "DropX",
      days_left: days !== null && days >= 0 ? String(days) : "",
      document_code: document.document_type,
      document_name: documentType?.name || document.document_type,
      expired_days: days !== null && days < 0 ? String(Math.abs(days)) : "",
      expiry_date: formatDate(document.expiry_date),
      location_code: vehicle?.station_code ?? "-",
      reminder_line: reminder.line,
      reminder_stage: reminder.stage,
      vehicle_no: document.vehicle_no
    };
    const subject = renderTemplate(template.subject_template, values);
    const body = renderTemplate(template.body_template, values);

    try {
      if (!toRecipients.length) throw new Error("No recipients found.");
      const threadMessageId = `<dropx.fleet-document.${document.id}.${reminder.key}@partner.dropxlogistics.com>`;
      const result = await sendEmail({
        body, cc: finalCcRecipients, companyId: company.id, subject, to: toRecipients,
        messageId: threadMessageId,
        inReplyTo: lastMessageId ?? undefined,
        references: lastMessageId ? [...new Set([rootMessageId, lastMessageId].filter((id): id is string => Boolean(id)))] : undefined
      });
      await supabaseAdmin.from("fleet_document_notification_logs").insert({
        company_id: company.id,
        fleet_vehicle_document_id: document.id,
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
      await supabaseAdmin.from("fleet_document_notification_logs").insert({
        company_id: company.id,
        fleet_vehicle_document_id: document.id,
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
