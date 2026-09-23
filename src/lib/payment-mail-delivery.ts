import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendEmail } from "@/lib/email";
import { isPendingPaymentApproval } from "@/lib/payment-stage-policy";
import { defaultPaymentWorkHours, nextPaymentReminder, paymentThreadMonth, validatePaymentWorkHours, withinPaymentWorkHours, type PaymentWorkHours } from "@/lib/payment-reminder-policy";

type PaymentStageRoles = {
  current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
  payment_process_role_ids?: string[] | null;
};

/** Finance/payment-processing is an execution queue, not an approval queue. */
export function isPaymentProcessingStage(request: PaymentStageRoles) {
  const processorRoles = new Set(request.payment_process_role_ids ?? []);
  if (request.current_approver_role_id && processorRoles.has(request.current_approver_role_id)) return true;
  return (request.current_approver_role_ids ?? []).some(roleId => processorRoles.has(roleId));
}

export async function loadPaymentMailPolicy(companyId: string) {
  const { data, error } = await supabaseAdmin!.from("payment_notification_templates")
    .select("event_type,is_enabled,reminder_interval_minutes,thread_by_station_month,reminder_work_hours")
    .eq("company_id", companyId).in("event_type", ["payment_request", "payment_reminder"]);
  if (error) throw new Error(error.message);
  const request = data?.find(row => row.event_type === "payment_request");
  const reminder = data?.find(row => row.event_type === "payment_reminder");
  const interval = Number(request?.reminder_interval_minutes ?? 90);
  if (!Number.isInteger(interval) || interval < 15 || interval > 1440) throw new Error("Invalid payment reminder interval.");
  return { enabled: Boolean(request?.is_enabled && reminder?.is_enabled), interval,
    monthly: request?.thread_by_station_month !== false,
    hours: validatePaymentWorkHours((request?.reminder_work_hours ?? defaultPaymentWorkHours) as PaymentWorkHours) };
}

// One database lease across all products/instances. Never use an in-memory lock.
export async function deliverPaymentMail(input: {
  companyId: string; requestId: string; expectedApprover: string | null;
  eventType: string; reminder?: boolean; catchUp?: boolean;
  mail: Parameters<typeof sendEmail>[0];
}) {
  const db = supabaseAdmin!;
  const policy = await loadPaymentMailPolicy(input.companyId);
  if (input.reminder && !policy.enabled) return { sent: false as const, reason: "Reminders disabled" };
  if (input.reminder && !input.catchUp && !withinPaymentWorkHours(new Date(), policy.hours))
    return { sent: false as const, reason: "Outside configured work hours" };
  const readRequest = () => db.from("payment_requests").select("id,location_id,location_code,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,payment_process_role_ids,email_next_reminder_at,email_send_count,email_root_message_id,email_last_message_id")
    .eq("company_id", input.companyId).eq("id", input.requestId).single();
  const initial = await readRequest();
  if (initial.error) throw new Error(initial.error.message);
  if (!initial.data.location_id) throw new Error("Payment email requires a station.");
  const now = new Date();
  const month = paymentThreadMonth(now, policy.hours.timezone);
  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: policy.hours.timezone }).format(now);
  const subject = `${initial.data.location_code} Payment Request ${monthLabel}`;
  const token = randomUUID();
  const claimed = await db.rpc("claim_payment_email_thread", { p_company: input.companyId, p_location: initial.data.location_id, p_month: month, p_token: token, p_subject: subject });
  if (claimed.error) throw new Error(claimed.error.message);
  const thread = claimed.data?.[0];
  if (!thread) return { sent: false as const, reason: "Station email is already being sent; retry on next scheduled run" };
  let attemptId: string | undefined;
  let smtpAccepted = false;
  try {
    const fresh = await readRequest();
    if (fresh.error) throw new Error(fresh.error.message);
    const request = fresh.data;
    const pending = Boolean(request.current_approver_user_id && isPendingPaymentApproval(request.status, request.approval_status));
    if (request.current_approver_user_id !== input.expectedApprover) return { sent: false as const, reason: "Approver changed; retry with current assignment" };
    if (input.reminder && isPaymentProcessingStage(request)) {
      await db.from("payment_requests").update({ email_next_reminder_at: null }).eq("company_id", input.companyId).eq("id", input.requestId);
      return { sent: false as const, reason: "Finance processing stages do not receive approval reminders" };
    }
    if (input.reminder && (!pending || (request.email_next_reminder_at && Date.parse(request.email_next_reminder_at) > Date.now())))
      return { sent: false as const, reason: "Decision completed or reminder not due" };
    // An interrupted SMTP operation cannot safely be retried automatically.
    const uncertain = await db.from("payment_email_attempts").select("id").eq("company_id", input.companyId).eq("request_id", input.requestId)
      .in("status", ["sending", "uncertain"]).limit(1);
    if (uncertain.error) throw new Error(uncertain.error.message);
    if (uncertain.data?.length) return { sent: false as const, reason: "Previous delivery needs reconciliation" };
    const messageId = policy.monthly ? (thread.last_message_id ? `<dropx.payment.${randomUUID()}@partner.dropxlogistics.com>` : thread.message_id) : input.mail.messageId;
    const actualSubject = policy.monthly ? thread.subject || subject : input.mail.subject;
    const last = policy.monthly ? thread.last_message_id : request.email_last_message_id;
    const root = policy.monthly ? thread.message_id : request.email_root_message_id;
    const attempt = await db.from("payment_email_attempts").insert({ company_id: input.companyId, request_id: input.requestId,
      event_type: input.eventType, recipients: input.mail.to, message_id: messageId, subject: actualSubject, status: "sending" }).select("id").single();
    if (attempt.error) throw new Error(attempt.error.message);
    attemptId = attempt.data.id;
    const result = await sendEmail({ ...input.mail, timeoutMs: 20_000, subject: actualSubject, messageId,
      inReplyTo: last || undefined, references: last ? [...new Set([root, last].filter(Boolean))] as string[] : undefined });
    smtpAccepted = true;
    const sentAt = new Date();
    // Persist the shared chain before releasing the lease or updating the next due time.
    const threadUpdate = await db.from("payment_notification_threads").update({ last_message_id: result.messageId,
      message_references: [root, result.messageId].filter(Boolean), subject: thread.subject || subject, updated_at: sentAt.toISOString() })
      .eq("id", thread.id).eq("lock_token", token);
    if (threadUpdate.error) throw new Error(threadUpdate.error.message);
    const afterSend = await readRequest();
    if (afterSend.error) throw new Error(afterSend.error.message);
    const stillPending = Boolean(afterSend.data.current_approver_user_id && isPendingPaymentApproval(afterSend.data.status, afterSend.data.approval_status));
    const nextDue = stillPending && policy.enabled && !isPaymentProcessingStage(afterSend.data)
      ? nextPaymentReminder(sentAt, policy.interval, policy.hours) : null;
    const updated = await db.from("payment_requests").update({ email_root_message_id: root || result.messageId,
      email_last_message_id: result.messageId, email_send_count: (request.email_send_count ?? 0) + 1, email_next_reminder_at: nextDue })
      .eq("company_id", input.companyId).eq("id", input.requestId);
    if (updated.error) throw new Error(updated.error.message);
    const logged = await db.from("payment_email_attempts").update({ status: "accepted", sent_at: sentAt.toISOString() }).eq("id", attemptId);
    if (logged.error) throw new Error(logged.error.message);
    return { sent: true as const, to: input.mail.to, cc: input.mail.cc ?? [] };
  } catch (error) {
    if (attemptId) await db.from("payment_email_attempts").update({ status: "uncertain", error_message: `${smtpAccepted ? "SMTP accepted; persistence failed: " : "SMTP outcome must be checked before retry: "}${error instanceof Error ? error.message : String(error)}` }).eq("id", attemptId);
    throw error;
  } finally {
    const released = await db.from("payment_notification_threads").update({ lock_token: null, locked_until: null }).eq("id", thread.id).eq("lock_token", token);
    if (released.error) console.error("Payment email lease release failed", released.error.message);
  }
}
