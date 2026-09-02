import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

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

export async function notifyAttendanceApprovalRequired(input: {
  companyId: string;
  requestId: string;
  recipientUserId: string | null;
  workerName: string;
  attendanceDate: string;
}) {
  if (!input.recipientUserId) return;
  const recipient = await recipientAccounts(input.companyId, input.recipientUserId);
  const uniqueAccounts = Array.from(new Map(recipient.accounts.map((item) => [`${item.profileType}:${item.accountId}`, item])).values());
  const dateLabel = input.attendanceDate.split("-").reverse().join("/");
  for (const account of uniqueAccounts) {
    await db().from("mob_app_notifications").insert({
      company_id: input.companyId,
      recipient_profile_type: account.profileType,
      recipient_account_id: account.accountId,
      event_code: "attendance_regularization_approval_required",
      title: "Attendance regularization needs approval",
      body: `${input.workerName} submitted attendance regularization for ${dateLabel}. Open Approval Inbox to review it.`,
      route: "approvals",
      data: { regularizationRequestId: input.requestId, attendanceDate: input.attendanceDate }
    });
  }
}
