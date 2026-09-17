import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type PaymentAdvanceEmailResult =
  | { sent: true; cc: string[]; to: string[] }
  | { sent: false; reason: string };

function skipped(reason: string): PaymentAdvanceEmailResult {
  return { sent: false, reason };
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function uniqueEmails(values: (string | null | undefined)[]) {
  return Array.from(new Set(values.map((email) => String(email ?? "").trim().toLowerCase()).filter((email) => email.includes("@"))));
}

/** Advance requests have no per-request approver on the row - decideAdvanceRequest
 * (advance-request/actions.ts) restricts the decision to company owners, so "the
 * approver" is dynamically resolved here as every active company-owner profile. */
async function ownerEmails(companyId: string) {
  if (!supabaseAdmin) return [];
  const ownerRole = await supabaseAdmin.from("user_roles").select("id").eq("company_id", companyId).eq("code", "OWNER").eq("is_active", true);
  const roleIds = (ownerRole.data ?? []).map((role) => role.id);
  const [roleOwners, masterOwners] = await Promise.all([
    roleIds.length
      ? supabaseAdmin.from("company_product_memberships").select("user_id").eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true).eq("is_master_owner", true)
  ]);
  const userIds = [...new Set([...(roleOwners.data ?? []).map((row) => row.user_id), ...(masterOwners.data ?? []).map((row) => row.id)])];
  if (!userIds.length) return [];
  const profiles = await supabaseAdmin.from("profiles").select("email").eq("company_id", companyId).eq("is_active", true).in("id", userIds);
  return uniqueEmails((profiles.data ?? []).map((row) => row.email));
}

type AdvanceRequestRow = {
  id: string;
  profile_type: string;
  account_id: string;
  account_code: string | null;
  requester_name: string | null;
  station_code: string | null;
  amount: number | null;
  purpose: string | null;
  status: string;
  approved_amount: number | null;
  decision_comment: string | null;
  email_root_message_id: string | null;
  email_last_message_id: string | null;
  email_send_count: number | null;
  source_app: string | null;
};

const sourceAppLabels: Record<string, string> = { ops: "Ops", one_app: "One App", hrms: "HRMS" };

async function requesterEmail(companyId: string, request: AdvanceRequestRow) {
  if (!supabaseAdmin) return null;
  const table = request.profile_type === "employee" ? "employees" : "contractors";
  const result = await supabaseAdmin.from(table).select("email").eq("company_id", companyId).eq("id", request.account_id).maybeSingle();
  const email = String(result.data?.email ?? "").trim().toLowerCase();
  return email.includes("@") ? email : null;
}

function buildSubjectBody(request: AdvanceRequestRow, companyName: string, kind: "submitted" | "reminder" | "approved" | "rejected" | "withdrawn") {
  const location = clean(request.station_code || "-");
  const requester = clean(request.requester_name || request.account_code || "Team member");
  const amount = request.amount == null ? "-" : `Rs ${Number(request.amount).toLocaleString("en-IN")}`;
  const lines = [
    `Request: ${request.account_code ?? request.id}`,
    `Location: ${location}`,
    `Requested By: ${requester}`,
    `Amount: ${amount}`,
    `Purpose: ${clean(request.purpose || "-")}`,
    `Status: ${clean(request.status)}`,
    `Source: ${sourceAppLabels[request.source_app ?? ""] ?? "One App"}`
  ];
  if (kind === "approved") lines.push(`Approved Amount: ${request.approved_amount == null ? "-" : `Rs ${Number(request.approved_amount).toLocaleString("en-IN")}`}`);
  if (kind === "rejected" || kind === "approved") lines.push(`Remarks: ${clean(request.decision_comment || "-")}`);
  const subjectSuffix = kind === "submitted" ? "pending approval"
    : kind === "reminder" ? "still pending approval"
    : kind === "approved" ? "approved"
    : kind === "withdrawn" ? "withdrawn"
    : "rejected";
  const subject = `[${location}] Advance request from ${requester} — ${subjectSuffix}`;
  const introduction = kind === "reminder"
    ? `Reminder ${(request.email_send_count ?? 0) + 1}: this advance request is still waiting for a decision. Please review it and respond.`
    : kind === "submitted" ? "A new advance request is pending approval."
    : kind === "approved" ? "The following advance request has been approved."
    : kind === "withdrawn" ? "The requester has withdrawn the following advance request. No further action is needed."
    : "The following advance request has been rejected.";
  const body = [`Dear Team,`, "", introduction, "", ...lines, "", "Regards,", `${companyName} Payments System`].join("\n");
  return { subject, body };
}

async function threadedSend(input: { companyId: string; request: AdvanceRequestRow; to: string[]; subject: string; body: string; scheduleNextReminder: boolean }): Promise<PaymentAdvanceEmailResult> {
  if (!supabaseAdmin) return skipped("Supabase service role key is not configured.");
  if (!input.to.length) return skipped("No recipients were resolved for this advance request email.");
  const messageId = `<dropx.payment-advance.${input.request.id}.${(input.request.email_send_count ?? 0) + 1}@partner.dropxlogistics.com>`;
  const lastMessageId = input.request.email_last_message_id ?? null;
  const rootMessageId = input.request.email_root_message_id ?? null;
  const result = await sendEmail({
    body: input.body,
    companyId: input.companyId,
    subject: input.subject,
    to: input.to,
    messageId,
    inReplyTo: lastMessageId ?? undefined,
    references: lastMessageId ? [...new Set([rootMessageId, lastMessageId].filter((id): id is string => Boolean(id)))] : undefined
  });
  await supabaseAdmin.from("payment_advance_requests").update({
    email_root_message_id: rootMessageId ?? result.messageId ?? messageId,
    email_last_message_id: result.messageId ?? messageId,
    email_send_count: (input.request.email_send_count ?? 0) + 1,
    email_next_reminder_at: input.scheduleNextReminder ? new Date(Date.now() + 90 * 60_000).toISOString() : null
  }).eq("company_id", input.companyId).eq("id", input.request.id);
  return { sent: true, cc: [], to: input.to };
}

async function loadRequest(companyId: string, requestId: string) {
  if (!supabaseAdmin) return null;
  const result = await supabaseAdmin
    .from("payment_advance_requests")
    .select("id, profile_type, account_id, account_code, requester_name, station_code, amount, purpose, status, approved_amount, decision_comment, email_root_message_id, email_last_message_id, email_send_count, source_app")
    .eq("company_id", companyId)
    .eq("id", requestId)
    .maybeSingle();
  if (result.error || !result.data) return null;
  return result.data as AdvanceRequestRow;
}

async function companyName(companyId: string) {
  if (!supabaseAdmin) return "DropX";
  const result = await supabaseAdmin.from("companies").select("name").eq("id", companyId).maybeSingle();
  return clean(result.data?.name || "DropX");
}

export async function sendPaymentAdvanceRequestNotification(companyId: string, requestId: string): Promise<PaymentAdvanceEmailResult> {
  try {
    const request = await loadRequest(companyId, requestId);
    if (!request) return skipped("Advance request not found.");
    const to = await ownerEmails(companyId);
    const { subject, body } = buildSubjectBody(request, await companyName(companyId), "submitted");
    return await threadedSend({ companyId, request, to, subject, body, scheduleNextReminder: request.status === "submitted" });
  } catch (error) {
    console.error("Advance request submission email failed", error);
    return skipped(error instanceof Error ? error.message : "Advance request submission email failed.");
  }
}

export async function sendPaymentAdvanceDecisionNotification(companyId: string, requestId: string, decision: "approved" | "rejected"): Promise<PaymentAdvanceEmailResult> {
  try {
    const request = await loadRequest(companyId, requestId);
    if (!request) return skipped("Advance request not found.");
    const to = uniqueEmails([await requesterEmail(companyId, request), ...(await ownerEmails(companyId))]);
    const { subject, body } = buildSubjectBody(request, await companyName(companyId), decision);
    return await threadedSend({ companyId, request, to, subject, body, scheduleNextReminder: false });
  } catch (error) {
    console.error("Advance request decision email failed", error);
    return skipped(error instanceof Error ? error.message : "Advance request decision email failed.");
  }
}

export async function sendPaymentAdvanceWithdrawalNotification(companyId: string, requestId: string): Promise<PaymentAdvanceEmailResult> {
  try {
    const request = await loadRequest(companyId, requestId);
    if (!request) return skipped("Advance request not found.");
    const to = await ownerEmails(companyId);
    const { subject, body } = buildSubjectBody(request, await companyName(companyId), "withdrawn");
    return await threadedSend({ companyId, request, to, subject, body, scheduleNextReminder: false });
  } catch (error) {
    console.error("Advance request withdrawal email failed", error);
    return skipped(error instanceof Error ? error.message : "Advance request withdrawal email failed.");
  }
}

export async function sendPaymentAdvanceReminder(companyId: string, requestId: string): Promise<PaymentAdvanceEmailResult> {
  try {
    const request = await loadRequest(companyId, requestId);
    if (!request) return skipped("Advance request not found.");
    if (!["submitted", "in_review"].includes(request.status)) {
      await supabaseAdmin!.from("payment_advance_requests").update({ email_next_reminder_at: null }).eq("company_id", companyId).eq("id", request.id);
      return skipped("This advance request is no longer awaiting approval.");
    }
    const to = await ownerEmails(companyId);
    const { subject, body } = buildSubjectBody(request, await companyName(companyId), "reminder");
    return await threadedSend({ companyId, request, to, subject, body, scheduleNextReminder: true });
  } catch (error) {
    console.error("Advance request reminder email failed", error);
    return skipped(error instanceof Error ? error.message : "Advance request reminder email failed.");
  }
}
