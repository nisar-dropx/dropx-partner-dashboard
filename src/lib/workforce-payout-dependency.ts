import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

export async function workforcePayoutDependencyHash(companyId: string, periodStart: string, periodEnd: string) {
  if (!supabaseAdmin) return { hash: null as string | null, error: "Database connection is not configured." };
  const result = await supabaseAdmin.rpc("workforce_advance_recovery_snapshot_hash", {
    p_company_id: companyId,
    p_period_start: periodStart,
    p_period_end: periodEnd
  });
  if (result.error || !result.data) {
    return { hash: null as string | null, error: result.error?.message ?? "Payout worksheet version is unavailable." };
  }
  return { hash: String(result.data), error: null as string | null };
}
