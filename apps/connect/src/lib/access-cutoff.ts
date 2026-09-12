import "server-only";

import { supabaseAdmin } from "./supabase-admin";

/**
 * Lazy offboarding-access enforcement for Connect login. Backed by the
 * hr_enforce_access_cutoff_for_connect RPC (defined in dropx-hrms's migrations, since
 * HRMS owns the exit-case/offboarding schema — all three apps share the same
 * database). Keyed by worker identity directly (company + employee/contractor + id),
 * matching how Connect's own login resolves an employee/contractor row by mobile
 * number rather than a profiles.id. If the worker's exit case's confirmed last
 * working day has passed, this flips employees/contractors.is_active off right now
 * instead of waiting for a scheduled job — there is none, by design. The heavier
 * one-time cleanup (Auth ban, Google Workspace suspend, audit trail) is HRMS's
 * responsibility, triggered from its own login path or its existing 5-minute cron.
 */
export async function enforceAccessCutoffIfDueForWorker(
  companyId: string,
  workerType: "employee" | "contractor",
  workerId: string
): Promise<boolean> {
  if (!supabaseAdmin) return true;
  const result = await supabaseAdmin.rpc("hr_enforce_access_cutoff_for_connect", {
    p_company_id: companyId,
    p_worker_type: workerType,
    p_worker_id: workerId
  });
  if (result.error) return true;
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return row?.is_active ?? true;
}
