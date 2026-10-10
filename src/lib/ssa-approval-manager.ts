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
  const assignment = await supabaseAdmin.from("hr_work_assignments").select("id,designation_id,location_id")
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
  let manager = unique[0];
  if (unique.length > 1) {
    // Several managers cover this station. The requester's own reporting line names
    // theirs; otherwise the manager most of the station reports to owns the request.
    // Only a genuine tie is left for People to settle.
    const own = await firstManagerInReportingLine(input.companyId, assignment.data.id, day, unique.map((candidate) => candidate.assignmentId));
    const ownManager = own ? unique.find((candidate) => candidate.assignmentId === own) : undefined;
    if (ownManager) manager = ownManager;
    else if (unique[0].supportCount === unique[1].supportCount) {
      throw new SsaApprovalRoutingError("More than one request approver is mapped to this station. Ask People to confirm its Cluster Manager or AOM.");
    }
  }
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

async function firstManagerInReportingLine(companyId: string, assignmentId: string, day: string, candidateAssignmentIds: string[]) {
  const candidates = new Set(candidateAssignmentIds);
  const seen = new Set<string>();
  let current: string | null = assignmentId;
  for (let depth = 0; current && depth < 16 && !seen.has(current); depth += 1) {
    seen.add(current);
    const relationship: { data: { manager_assignment_id: string | null } | null; error: { message: string } | null } = await supabaseAdmin!
      .from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", current)
      .eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (relationship.error) throw new Error(relationship.error.message);
    current = relationship.data?.manager_assignment_id ?? null;
    if (current && candidates.has(current)) return current;
  }
  return null;
}
