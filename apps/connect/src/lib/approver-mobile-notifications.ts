import "server-only";

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
        if (accountId) accounts.push({ profileType: String(engagement.worker_type), accountId: String(accountId) });
      }
    }
  }
  return { profile: profile.data, accounts };
}

/** DropX One inbox for portal users (profiles.id), including managers without email. */
export async function notifyApproverMobile(input: {
  companyId: string;
  recipientUserId: string | null | undefined;
  eventCode: string;
  title: string;
  body: string;
  route?: "approvals" | "reimbursements" | "roster" | "exits";
  sourceKey?: string | null;
  data?: Record<string, unknown>;
}) {
  if (!input.recipientUserId) return;
  const recipient = await recipientAccounts(input.companyId, input.recipientUserId);
  const uniqueAccounts = Array.from(
    new Map(recipient.accounts.map((item) => [`${item.profileType}:${item.accountId}`, item])).values()
  );
  for (const account of uniqueAccounts) {
    const row = {
      company_id: input.companyId,
      recipient_profile_type: account.profileType,
      recipient_account_id: account.accountId,
      event_code: input.eventCode,
      title: input.title,
      body: input.body,
      route: input.route ?? "approvals",
      data: input.data ?? {},
      ...(input.sourceKey ? { source_key: input.sourceKey } : {}),
      push_status: "not_configured"
    };
    const inserted = input.sourceKey
      ? await db().from("mob_app_notifications").upsert(row, {
          onConflict: "company_id,event_code,source_key,recipient_account_id",
          ignoreDuplicates: true
        })
      : await db().from("mob_app_notifications").insert(row);
    if (inserted.error && !/mob_app_notifications|schema cache|does not exist|duplicate/i.test(inserted.error.message)) {
      throw new Error(inserted.error.message);
    }
  }
}

export async function notifyApproversMobile(
  input: Omit<Parameters<typeof notifyApproverMobile>[0], "recipientUserId"> & {
    recipientUserIds: Array<string | null | undefined>;
  }
) {
  const unique = [...new Set(input.recipientUserIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  for (const recipientUserId of unique) {
    await notifyApproverMobile({ ...input, recipientUserId });
  }
}
