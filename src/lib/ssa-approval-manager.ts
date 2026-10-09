import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { resolveConnectApproverUserId } from "@/lib/connect-approver-identity";
import { loadPeopleOperationalHierarchy } from "./people-operational-hierarchy";

export class SsaApprovalRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsaApprovalRoutingError";
  }
}

/** SSA requests belong to the station's CM, or its AOM when no CM is mapped.
 * This changes request ownership, never the person's organisational reporting line.
 * A mapped manager without a login is a configuration error, not permission to
 * fall back to a TL or an unrelated manager.
 */
export async function resolveSsaApprovalManager(input: {
  companyId: string;
  workerType: "employee" | "contractor";
  workerId: string;
  asOf?: string;
}) {
  if (!supabaseAdmin) throw new Error("Database configuration is missing.");
  const day = input.asOf ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const engagement = await supabaseAdmin.from("hr_engagements").select("id,person_id")
    .eq("company_id", input.companyId).eq("worker_type", input.workerType)
    .eq(input.workerType === "employee" ? "employee_id" : "contractor_id", input.workerId)
    .eq("status", "active").lte("start_date", day).or(`end_date.is.null,end_date.gte.${day}`)
    .order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data) return null;
  const assignment = await supabaseAdmin.from("hr_work_assignments").select("designation_id,location_id")
    .eq("company_id", input.companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true)
    .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error) throw new Error(assignment.error.message);
  if (!assignment.data?.designation_id) return null;
  const designation = await supabaseAdmin.from("designations").select("code")
    .eq("company_id", input.companyId).eq("id", assignment.data.designation_id).maybeSingle();
  if (designation.error) throw new Error(designation.error.message);
  if (String(designation.data?.code ?? "").trim().toUpperCase() !== "SSA") return null;

  const stationId = assignment.data.location_id;
  if (!stationId) throw new SsaApprovalRoutingError("Map a station to this SSA assignment before submitting the request.");
  const result = await loadPeopleOperationalHierarchy(input.companyId, [stationId], { includeStationResponsibilities: true, asOf: day });
  if (result.error) throw new SsaApprovalRoutingError(result.error);
  const hierarchy = result.byLocation.get(stationId);
  const clusterManagers = hierarchy?.clusterManagers ?? [];
  const candidates = clusterManagers.length ? clusterManagers : hierarchy?.areaOperationsManagers ?? [];
  const unique = [...new Map(candidates.map((candidate) => [candidate.personId, candidate])).values()];
  if (hierarchy?.hasClusterManagerConflict || unique.length > 1) {
    throw new SsaApprovalRoutingError("More than one request approver is mapped to this station. Ask People to confirm its Cluster Manager or AOM.");
  }
  const manager = unique[0];
  if (!manager || manager.personId === engagement.data.person_id) {
    throw new SsaApprovalRoutingError("Map a Cluster Manager or Area Operations Manager to this station before submitting the request.");
  }
  const userId = await resolveConnectApproverUserId(input.companyId, manager.personId);
  if (!userId) throw new SsaApprovalRoutingError(`${manager.name} does not have an active One/People approval login. Ask People to complete the manager's access.`);
  return {
    ...manager,
    userId,
    isAomFallback: clusterManagers.length === 0,
    stepName: clusterManagers.length ? "Cluster Manager approval" : "Area Operations Manager approval",
    fallbackReason: clusterManagers.length ? null : "No Cluster Manager mapped to this station"
  };
}
