import "server-only";

import { sendConnectEmail } from "./connect-email";
import { supabaseAdmin } from "./supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

async function recipientAccounts(companyId: string, userId: string) {
  const profile = await db().from("profiles").select("id,full_name,email").eq("company_id", companyId).eq("id", userId).maybeSingle();
  if (profile.error) throw new Error(profile.error.message);
  const link = await db().from("hr_user_person_links").select("person_id,status").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  const accounts: Array<{ profileType: string; accountId: string }> = [{ profileType: "user", accountId: userId }];
  if (link.data?.status === "active") {
    const engagements = await db().from("hr_engagements").select("worker_type,employee_id,contractor_id,status")
      .eq("company_id", companyId).eq("person_id", link.data.person_id).eq("status", "active");
    if (!engagements.error) {
      for (const engagement of engagements.data ?? []) {
        const accountId = engagement.worker_type === "employee" ? engagement.employee_id : engagement.contractor_id;
        if (accountId) accounts.push({ profileType: engagement.worker_type, accountId });
      }
    }
  }
  return { profile: profile.data, accounts };
}

export async function dismissExpenseApprovalNotifications(input: {
  companyId: string;
  claimId?: string | null;
  claimRequestId?: string | null;
}) {
  if (!input.claimId && !input.claimRequestId) return;
  const now = new Date().toISOString();
  let query = db().from("mob_app_notifications")
    .update({ read_at: now, archived_at: now })
    .eq("company_id", input.companyId)
    .in("event_code", ["REIMBURSEMENT_REQUEST_APPROVAL_REQUIRED", "REIMBURSEMENT_APPROVAL_REQUIRED"])
    .is("archived_at", null);
  if (input.claimRequestId) query = query.contains("data", { claimRequestId: input.claimRequestId });
  if (input.claimId) query = query.contains("data", { claimId: input.claimId });
  const result = await query;
  if (result.error && !/mob_app_notifications|schema cache|does not exist/i.test(result.error.message)) {
    throw new Error(result.error.message);
  }
}

export async function notifyExpenseUser(input: {
  companyId: string;
  claimId?: string | null;
  claimRequestId?: string | null;
  recipientUserId: string | null;
  eventCode: string;
  title: string;
  body: string;
  emailSubject: string;
  emailBody: string;
  route?: "approvals" | "reimbursements";
}) {
  if (!input.recipientUserId) return { status: "skipped" as const, error: "Recipient login is not linked." };
  const recipient = await recipientAccounts(input.companyId, input.recipientUserId);
  const uniqueAccounts = Array.from(new Map(recipient.accounts.map((item) => [`${item.profileType}:${item.accountId}`, item])).values());
  for (const account of uniqueAccounts) {
    const inserted = await db().from("mob_app_notifications").insert({
      company_id: input.companyId,
      recipient_profile_type: account.profileType,
      recipient_account_id: account.accountId,
      event_code: input.eventCode,
      title: input.title,
      body: input.body,
      route: input.route ?? "reimbursements",
      data: {
        ...(input.claimId ? { claimId: input.claimId } : {}),
        ...(input.claimRequestId ? { claimRequestId: input.claimRequestId } : {})
      }
    });
    if (inserted.error && !/mob_app_notifications|schema cache|does not exist/i.test(inserted.error.message)) {
      throw new Error(inserted.error.message);
    }
  }
  const email = recipient.profile?.email?.trim();
  if (!email) return { status: "skipped" as const, error: "Recipient email is missing." };
  const logPayload: Record<string, unknown> = {
    company_id: input.companyId,
    event_code: input.eventCode,
    recipient_user_id: input.recipientUserId,
    recipient_email: email,
    channel: "email",
    status: "sending"
  };
  if (input.claimId) logPayload.claim_id = input.claimId;
  if (input.claimRequestId) logPayload.claim_request_id = input.claimRequestId;
  const log = await db().from("hr_expense_notification_log").insert(logPayload).select("id").single();
  try {
    await sendConnectEmail({ companyId: input.companyId, to: [email], subject: input.emailSubject, body: input.emailBody });
    if (log.data) await db().from("hr_expense_notification_log").update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", log.data.id);
    return { status: "sent" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    if (log.data) await db().from("hr_expense_notification_log").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", log.data.id);
    return { status: "failed" as const, error: message };
  }
}
