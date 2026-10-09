import "server-only";

import { supabaseAdmin } from "./supabase-admin";

/**
 * Lazy offboarding-access enforcement for Connect login. Backed by the
 * hr_enforce_access_cutoff_for_connect RPC (defined in dropx-hrms's migrations, since
 * HRMS owns the exit-case/offboarding schema — all three apps share the same
 * database). Keyed by worker identity directly (company + employee/contractor + id),
 * matching how Connect's own login resolves an employee/contractor row by mobile
 * number rather than a profiles.id.
 *
 * The app (Connect/DropX One) stays usable through the confirmed last working day
 * (LWD) AND through clearance: once the LWD has passed, website/portal access is cut
 * off first, but the app itself keeps working until clearance also completes
 * (hr_exit_cases.status reaching documents_ready/closed) — only then does this flip
 * employees/contractors.is_active off, which is what Connect's own queries filter on.
 * There is no scheduled job for this by design; it's enforced lazily on login. The
 * heavier one-time cleanup (Auth ban, Google Workspace suspend, audit trail) is HRMS's
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
  return row?.app_active ?? true;
}

// A preview must observe the same cutoff without changing the worker or their links.
export async function readAccessCutoffForPreview(companyId: string, workerType: "employee" | "contractor", workerId: string) {
  if (!supabaseAdmin) return false;
  const result = await supabaseAdmin.from("hr_exit_cases").select("access_cutoff_at,status")
    .eq("company_id", companyId).eq("worker_type", workerType).eq(`${workerType}_id`, workerId)
    .not("status", "in", "(closed,rejected,withdrawn,cancelled)").order("submitted_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw result.error;
  return !(result.data?.access_cutoff_at && Date.parse(result.data.access_cutoff_at) <= Date.now() && result.data.status === "documents_ready");
}
