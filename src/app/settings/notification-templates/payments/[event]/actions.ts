"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendPaymentApprovalReminder, type PaymentEmailEventType } from "@/lib/payment-email-notifications";
import { isPendingPaymentApproval } from "@/lib/payment-stage-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { validatePaymentWorkHours } from "@/lib/payment-reminder-policy";
import { isPaymentProcessingStage } from "@/lib/payment-mail-delivery";

const allowedEvents = new Set(["payment_request", "payment_approve", "payment_return", "payment_reject"]);

// Administrator-requested catch-up is explicit, company-scoped, and still
// respects due times and the shared lease. It may run outside working hours.
export async function sendMissedPaymentReminders() {
  const authorization = await requirePagePermission("app_settings", "edit");
  const companyId = requireCompanyId(authorization);
  let notice = "";
  try {
    if (!supabaseAdmin) throw new Error("Supabase is not configured.");
    const pending = await supabaseAdmin.from("payment_requests").select("id,status,approval_status,current_approver_role_id,current_approver_role_ids,payment_process_role_ids")
      .eq("company_id", companyId).not("current_approver_user_id", "is", null)
      .not("status", "in", "(approved,processed,processing,returned,rejected,cancelled)")
      .or(`email_next_reminder_at.is.null,email_next_reminder_at.lte.${new Date().toISOString()}`)
      .order("email_next_reminder_at", { ascending: true, nullsFirst: true }).limit(200);
    if (pending.error) throw new Error(pending.error.message);
    const rows = (pending.data ?? []).filter(row =>
      isPendingPaymentApproval(row.status, row.approval_status) && !isPaymentProcessingStage(row)
    );
    const deadline = Date.now() + 40_000;
    let sent = 0, checked = 0;
    const reasons: string[] = [];
    for (const row of rows) {
      if (Date.now() > deadline) break;
      const result = await sendPaymentApprovalReminder(companyId, row.id, { catchUp: true });
      checked++;
      if (result.sent) sent++; else reasons.push(result.reason);
    }
    notice = `${sent} reminder emails accepted for sending; ${rows.length - checked} still to check.${reasons.length ? ` Skipped: ${[...new Set(reasons)].join("; ")}` : ""}`;
    revalidatePath(eventPath("payment_request"));
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash("payment_request", { error: error instanceof Error ? error.message : "Catch-up failed" });
  }
  redirectWithFlash("payment_request", { notice });
}
const baseRecipients = ["requester", "current_approver", "location_manager", "final_approver", "payment_processor"];
const allowedRecipients = new Set([
  ...baseRecipients,
  ...baseRecipients.map((recipient) => `initial:${recipient}`),
  ...baseRecipients.map((recipient) => `final:${recipient}`)
]);

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function eventTypeFromForm(formData: FormData): PaymentEmailEventType {
  const eventType = clean(formData.get("event_type"));
  if (!eventType || !allowedEvents.has(eventType)) throw new Error("Payment notification type is invalid.");
  return eventType as PaymentEmailEventType;
}

function recipients(formData: FormData, field: string) {
  return formData
    .getAll(field)
    .map((value) => String(value).trim())
    .filter((value) => allowedRecipients.has(value));
}

function emails(formData: FormData, field: string) {
  return Array.from(new Set(
    String(formData.get(field) ?? "")
      .split(/[,\n;]/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.includes("@"))
  ));
}

function prefixedRecipients(formData: FormData, phase: "initial" | "final", field: string) {
  return recipients(formData, `${phase}_${field}`).map((recipient) => `${phase}:${recipient}`);
}

function prefixedEmails(formData: FormData, phase: "initial" | "final", field: string) {
  return emails(formData, `${phase}_${field}`).map((email) => `${phase}:${email}`);
}

function eventPath(eventType: PaymentEmailEventType) {
  return `/settings/notification-templates/payments/${eventType.replace("payment_", "")}`;
}

function redirectWithFlash(eventType: PaymentEmailEventType, params: { error?: string; notice?: string }): never {
  cookies().set(`dropx_payment_notification_${eventType}_flash`, JSON.stringify(params), {
    httpOnly: true,
    maxAge: 20,
    path: eventPath(eventType),
    sameSite: "lax"
  });
  redirect(eventPath(eventType));
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

export async function savePaymentNotificationTemplate(formData: FormData) {
  const eventType = eventTypeFromForm(formData);
  const authorization = await requirePagePermission("app_settings", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const reminderSettings = eventType === "payment_request" ? {
      reminder_interval_minutes: Number(formData.get("reminder_interval_minutes")),
      thread_by_station_month: formData.get("thread_by_station_month") === "on",
      reminder_work_hours: validatePaymentWorkHours({ timezone: required(formData.get("reminder_timezone"), "Timezone"),
        start: required(formData.get("reminder_start"), "Start time"), end: required(formData.get("reminder_end"), "End time"),
        days: formData.getAll("reminder_days").map(Number) })
    } : {};
    if (eventType === "payment_request" && (!Number.isInteger(reminderSettings.reminder_interval_minutes) || reminderSettings.reminder_interval_minutes! < 15 || reminderSettings.reminder_interval_minutes! > 1440))
      throw new Error("Reminder interval must be between 15 and 1440 minutes.");
    const toRecipients = eventType === "payment_approve"
      ? [
          ...prefixedRecipients(formData, "initial", "to_recipients"),
          ...prefixedRecipients(formData, "final", "to_recipients")
        ]
      : recipients(formData, "to_recipients");
    const ccRecipients = eventType === "payment_approve"
      ? [
          ...prefixedRecipients(formData, "initial", "cc_recipients").filter((value) => !toRecipients.includes(value)),
          ...prefixedRecipients(formData, "final", "cc_recipients").filter((value) => !toRecipients.includes(value))
        ]
      : recipients(formData, "cc_recipients").filter((value) => !toRecipients.includes(value));
    const customToEmails = eventType === "payment_approve"
      ? [
          ...prefixedEmails(formData, "initial", "custom_to_emails"),
          ...prefixedEmails(formData, "final", "custom_to_emails")
        ]
      : emails(formData, "custom_to_emails");
    const customCcEmails = eventType === "payment_approve"
      ? [
          ...prefixedEmails(formData, "initial", "custom_cc_emails"),
          ...prefixedEmails(formData, "final", "custom_cc_emails")
        ].filter((email) => !customToEmails.includes(email))
      : emails(formData, "custom_cc_emails").filter((email) => !customToEmails.includes(email));
    const initialToConfigured = toRecipients.some((value) => value.startsWith("initial:")) ||
      customToEmails.some((value) => value.startsWith("initial:"));
    const finalToConfigured = toRecipients.some((value) => value.startsWith("final:")) ||
      customToEmails.some((value) => value.startsWith("final:"));
    if (eventType === "payment_approve") {
      if (formData.get("initial_is_enabled") === "on" && !initialToConfigured) {
        throw new Error("Select at least one To recipient or custom To email for Initial Approval email.");
      }
      if (formData.get("final_is_enabled") === "on" && !finalToConfigured) {
        throw new Error("Select at least one To recipient or custom To email for Final Approval email.");
      }
    } else if (!toRecipients.length && !customToEmails.length) {
      throw new Error("Select at least one To recipient or custom To email.");
    }
    const initialSubjectTemplate = eventType === "payment_approve"
      ? required(formData.get("initial_subject_template"), "Initial Approval subject template")
      : null;
    const initialBodyTemplate = eventType === "payment_approve"
      ? required(formData.get("initial_body_template"), "Initial Approval body template")
      : null;
    const finalSubjectTemplate = eventType === "payment_approve"
      ? required(formData.get("final_subject_template"), "Final Approval subject template")
      : null;
    const finalBodyTemplate = eventType === "payment_approve"
      ? required(formData.get("final_body_template"), "Final Approval body template")
      : null;

    const { error } = await (supabaseAdmin.from("payment_notification_templates") as any).upsert({
      ...reminderSettings,
      company_id: companyId,
      event_type: eventType,
      is_enabled: eventType === "payment_approve"
        ? formData.get("initial_is_enabled") === "on" || formData.get("final_is_enabled") === "on"
        : formData.get("is_enabled") === "on",
      initial_is_enabled: eventType === "payment_approve" ? formData.get("initial_is_enabled") === "on" : false,
      final_is_enabled: eventType === "payment_approve" ? formData.get("final_is_enabled") === "on" : false,
      to_recipients: toRecipients,
      cc_recipients: ccRecipients,
      custom_to_emails: customToEmails,
      custom_cc_emails: customCcEmails,
      subject_template: eventType === "payment_approve"
        ? initialSubjectTemplate
        : required(formData.get("subject_template"), "Subject template"),
      body_template: eventType === "payment_approve"
        ? initialBodyTemplate
        : required(formData.get("body_template"), "Body template"),
      initial_subject_template: initialSubjectTemplate,
      initial_body_template: initialBodyTemplate,
      final_subject_template: finalSubjectTemplate,
      final_body_template: finalBodyTemplate,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,event_type" });
    if (error) throw new Error(error.message);
    if (eventType === "payment_request") {
      const reminder = await supabaseAdmin.from("payment_notification_templates").upsert({ company_id: companyId, event_type: "payment_reminder",
        is_enabled: formData.get("reminders_enabled") === "on", to_recipients: ["current_approver"], cc_recipients: [],
        subject_template: "{{station_month}}", body_template: "Review the pending payment and Approve, Return or Reject.", ...reminderSettings }, { onConflict: "company_id,event_type" });
      if (reminder.error) throw new Error(reminder.error.message);
    }

    revalidatePath("/settings/notification-templates/email");
    revalidatePath(eventPath(eventType));
    redirectWithFlash(eventType, { notice: "Payment notification template saved." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash(eventType, { error: error instanceof Error ? error.message : "Unable to save payment notification template." });
  }
}
