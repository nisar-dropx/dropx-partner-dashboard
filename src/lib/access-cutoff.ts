import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Lazy offboarding-access enforcement: call this before trusting is_active on any
 * login/access path in this app. Backed by the hr_enforce_access_cutoff RPC (defined
 * in dropx-hrms's migrations, since HRMS owns the exit-case/offboarding schema — both
 * apps share the same database). Resolves the worker behind `profileId` and, if their
 * exit case's confirmed last working day has passed, flips employees/contractors
 * is_active and hr_user_person_links.status off right now instead of waiting for a
 * scheduled job — there is none, by design. The heavier one-time cleanup (Auth ban,
 * Google Workspace suspend, audit trail) is HRMS's responsibility, triggered from its
 * own login path or its existing 5-minute cron; this call only needs the fast boolean.
 */
export async function enforceAccessCutoffIfDue(profileId: string): Promise<boolean> {
  if (!supabaseAdmin) return true;
  const result = await supabaseAdmin.rpc("hr_enforce_access_cutoff", { p_profile_id: profileId });
  if (result.error) return true;
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return row?.is_active ?? true;
}

/**
 * Same lazy cutoff enforcement, keyed by worker identity directly (company id +
 * employee/contractor + id) — for login paths that resolve an employee/contractor row
 * by mobile number rather than a profiles.id (Connect app login).
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
