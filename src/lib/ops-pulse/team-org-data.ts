import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { buildTeamOrgView, type TeamOrgPerson } from "@/lib/ops-pulse/team-org-core";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";

const ID_BATCH_SIZE = 100;

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * The company's live People reporting graph, matching the People Org Chart:
 * each active engagement's latest open primary assignment, joined to its
 * current solid-line manager. Read whole (paged, never by ID list) so one
 * cached copy serves every viewer's scoped view.
 */
async function fetchCompanyTeamOrg(companyId: string): Promise<TeamOrgPerson[]> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const admin = supabaseAdmin;
  const day = indiaToday();
  const results = await Promise.all([
    readAllRows(admin.from("hr_work_assignments")
      .select("id,engagement_id,location_id,department_id,designation_id,position_title,is_top_level")
      .eq("company_id", companyId).eq("is_primary", true)
      .or(`effective_to.is.null,effective_to.gte.${day}`)
      .order("effective_from", { ascending: false }).order("id")),
    readAllRows(admin.from("hr_engagements")
      .select("id,person_id,worker_type,worker_code,employee_id,contractor_id")
      .eq("company_id", companyId).eq("status", "active").order("id")),
    readAllRows(admin.from("hr_people").select("id,display_name").eq("company_id", companyId).eq("status", "active").order("id")),
    readAllRows(admin.from("employees").select("id").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).order("id")),
    readAllRows(admin.from("contractors").select("id").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).order("id")),
    readAllRows(admin.from("hr_reporting_relationships")
      .select("subject_assignment_id,manager_assignment_id")
      .eq("company_id", companyId).eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
      .order("effective_from", { ascending: false }).order("id")),
    readAllRows(admin.from("stations").select("id,station_code,station_name").eq("company_id", companyId).order("id")),
    readAllRows(admin.from("hr_departments").select("id,name").eq("company_id", companyId).order("id")),
    readAllRows(admin.from("designations").select("id,code,name").eq("company_id", companyId).order("id"))
  ]);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new Error(failed.error.message);
  const [assignmentRows, engagementRows, peopleRows, employeeRows, contractorRows, relationshipRows, stationRows, departmentRows, designationRows] =
    results.map((result) => result.data ?? []);

  const latestByEngagement = new Map<string, (typeof assignmentRows)[number]>();
  const engagementByAssignment = new Map<string, string>();
  for (const row of assignmentRows) {
    engagementByAssignment.set(row.id, row.engagement_id);
    if (!latestByEngagement.has(row.engagement_id)) latestByEngagement.set(row.engagement_id, row);
  }

  // A reporting line keeps the manager assignment that was current when it was
  // saved. Resolve ended ones to that manager's present assignment so a
  // promotion or transfer does not detach their team.
  const endedManagerIds = [...new Set(relationshipRows.map((row) => row.manager_assignment_id as string))]
    .filter((id) => id && !engagementByAssignment.has(id));
  for (let index = 0; index < endedManagerIds.length; index += ID_BATCH_SIZE) {
    const ended = await admin.from("hr_work_assignments").select("id,engagement_id")
      .eq("company_id", companyId).in("id", endedManagerIds.slice(index, index + ID_BATCH_SIZE));
    if (ended.error) throw new Error(ended.error.message);
    for (const row of ended.data ?? []) engagementByAssignment.set(row.id, row.engagement_id);
  }
  const managerBySubject = new Map<string, string>();
  for (const row of relationshipRows) {
    if (managerBySubject.has(row.subject_assignment_id)) continue;
    const engagementId = engagementByAssignment.get(row.manager_assignment_id);
    managerBySubject.set(row.subject_assignment_id, (engagementId ? latestByEngagement.get(engagementId)?.id : null) ?? row.manager_assignment_id);
  }

  const personName = new Map<string, string>(peopleRows.map((row) => [row.id, row.display_name]));
  const activeEmployees = new Set<string>(employeeRows.map((row) => row.id));
  const activeContractors = new Set<string>(contractorRows.map((row) => row.id));
  const stationCode = new Map<string, string>(stationRows.map((row) => [row.id, row.station_code || row.station_name]));
  const departmentName = new Map<string, string>(departmentRows.map((row) => [row.id, row.name]));
  const designation = new Map<string, { code: string | null; name: string | null }>(designationRows.map((row) => [row.id, row]));

  return engagementRows.flatMap((engagement): TeamOrgPerson[] => {
    const assignment = latestByEngagement.get(engagement.id);
    const name = personName.get(engagement.person_id);
    const sourceActive = engagement.worker_type === "employee"
      ? activeEmployees.has(engagement.employee_id)
      : activeContractors.has(engagement.contractor_id);
    if (!assignment || !name || !sourceActive) return [];
    const role = assignment.designation_id ? designation.get(assignment.designation_id) : null;
    return [{
      id: assignment.id,
      personId: engagement.person_id,
      managerId: managerBySubject.get(assignment.id) ?? null,
      name,
      code: engagement.worker_code ?? null,
      title: role?.name || assignment.position_title || "Role not assigned",
      designationCode: role?.code ?? null,
      locationId: assignment.location_id ?? null,
      location: assignment.location_id ? stationCode.get(assignment.location_id) ?? null : null,
      department: assignment.department_id ? departmentName.get(assignment.department_id) ?? null : null,
      isTopLevel: Boolean(assignment.is_top_level)
    }];
  });
}

// Reporting lines change a few times a day at most; five minutes of staleness
// keeps the nine company-wide reads off the database for almost every view.
const cachedCompanyTeamOrg = unstable_cache(fetchCompanyTeamOrg, ["ops-team-org-v1"], { revalidate: 300 });
const loadCompanyTeamOrg = cache((companyId: string) => cachedCompanyTeamOrg(companyId));

export async function loadTeamOrgView(auth: AuthorizationContext) {
  if (!supabaseAdmin || !auth.companyId) throw new Error("My Team & Org is unavailable for this login.");
  const [people, link] = await Promise.all([
    loadCompanyTeamOrg(auth.companyId),
    supabaseAdmin.from("hr_user_person_links").select("person_id")
      .eq("company_id", auth.companyId).eq("user_id", auth.userId).eq("status", "active").limit(1)
  ]);
  if (link.error) throw new Error("Unable to check your People profile.");
  return buildTeamOrgView(people, {
    personId: link.data?.[0]?.person_id ?? null,
    allLocations: isCompanyOwner(auth) || auth.hasAllLocationAccess,
    locationIds: auth.locationScopeIds
  });
}
