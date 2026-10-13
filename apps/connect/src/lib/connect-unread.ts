import type { SupabaseClient } from "@supabase/supabase-js";

type Account = { companyId: string; profileType: string; id: string };
export type ConnectUnread = { updates: number; cases: Record<string, string[]>; total: number };

/** Receipts are independent of clearing the bell. Case IDs remain reporter-scoped. */
export async function loadConnectUnread(db: SupabaseClient, account: Account): Promise<ConnectUnread> {
  const [receipts, reporters, notices] = await Promise.all([
    db.from("communication_announcement_recipients").select("announcement_id")
      .eq("company_id", account.companyId).eq("recipient_profile_type", account.profileType)
      .eq("recipient_account_id", account.id).is("read_at", null),
    db.from("communication_case_reporters").select("case_id")
      .eq("company_id", account.companyId).eq("reporter_profile_type", account.profileType).eq("reporter_account_id", account.id),
    db.from("mob_app_notifications").select("id,data")
      .eq("company_id", account.companyId).eq("recipient_profile_type", account.profileType)
      .eq("recipient_account_id", account.id).eq("event_code", "communication_case_update")
      .is("read_at", null).is("archived_at", null)
  ]);
  for (const result of [receipts, reporters, notices]) if (result.error) throw result.error;
  const ids = (receipts.data ?? []).map(row => row.announcement_id);
  const published = ids.length ? await db.from("communication_announcements").select("id")
    .eq("company_id", account.companyId).eq("status", "published").in("id", ids)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`) : { data: [], error: null };
  if (published.error) throw published.error;
  const owned = new Set((reporters.data ?? []).map(row => row.case_id));
  const cases: Record<string, string[]> = {};
  for (const row of notices.data ?? []) {
    const caseId = String(row.data?.caseId ?? "");
    if (owned.has(caseId)) (cases[caseId] ??= []).push(row.id);
  }
  const updates = published.data?.length ?? 0;
  return { updates, cases, total: updates + Object.values(cases).reduce((sum, rows) => sum + rows.length, 0) };
}
