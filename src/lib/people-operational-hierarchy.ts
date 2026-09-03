import {
  resolvePeopleOperationalHierarchy,
  type LocationOperationalHierarchy,
  type PeopleHierarchyAssignment,
  type PeopleHierarchyRelationship
} from "@/lib/people-operational-hierarchy-core";
import { supabaseAdmin } from "@/lib/supabase-admin";

type WorkAssignmentRow = {
  id: string;
  engagement_id: string;
  location_id: string | null;
  designation_id: string | null;
  position_title: string | null;
};

type EngagementRow = { id: string; person_id: string; status: string };
type PersonRow = { id: string; display_name: string; status: string };
type DesignationRow = { id: string; code: string | null; name: string | null };
type RelationshipRow = {
  subject_assignment_id: string;
  manager_assignment_id: string;
  effective_from: string;
};

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export async function loadPeopleOperationalHierarchy(companyId: string, locationIds: string[]) {
  const empty = new Map<string, LocationOperationalHierarchy>();
  if (!supabaseAdmin || !locationIds.length) return { byLocation: empty, error: null as string | null };
  const day = indiaToday();
  const [assignmentsResult, engagementsResult, peopleResult, designationsResult, relationshipsResult] = await Promise.all([
    supabaseAdmin.from("hr_work_assignments")
      .select("id,engagement_id,location_id,designation_id,position_title")
      .eq("company_id", companyId).eq("is_primary", true)
      .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`),
    supabaseAdmin.from("hr_engagements")
      .select("id,person_id,status")
      .eq("company_id", companyId).eq("status", "active"),
    supabaseAdmin.from("hr_people")
      .select("id,display_name,status")
      .eq("company_id", companyId).eq("status", "active"),
    supabaseAdmin.from("designations")
      .select("id,code,name")
      .eq("company_id", companyId).eq("is_active", true),
    supabaseAdmin.from("hr_reporting_relationships")
      .select("subject_assignment_id,manager_assignment_id,effective_from")
      .eq("company_id", companyId).eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`)
      .order("effective_from", { ascending: false })
  ]);
  const error = assignmentsResult.error?.message || engagementsResult.error?.message || peopleResult.error?.message ||
    designationsResult.error?.message || relationshipsResult.error?.message || null;
  if (error) return { byLocation: empty, error };

  const engagements = new Map(((engagementsResult.data ?? []) as EngagementRow[]).map((row) => [row.id, row]));
  const people = new Map(((peopleResult.data ?? []) as PersonRow[]).map((row) => [row.id, row]));
  const designations = new Map(((designationsResult.data ?? []) as DesignationRow[]).map((row) => [row.id, row]));
  const assignments = ((assignmentsResult.data ?? []) as WorkAssignmentRow[]).flatMap((row) => {
    const engagement = engagements.get(row.engagement_id);
    const person = engagement ? people.get(engagement.person_id) : null;
    if (!engagement || !person) return [];
    const designation = row.designation_id ? designations.get(row.designation_id) : null;
    return [{
      id: row.id,
      personId: person.id,
      displayName: person.display_name,
      locationId: row.location_id,
      designationCode: designation?.code ?? null,
      designationName: designation?.name ?? null,
      positionTitle: row.position_title
    } satisfies PeopleHierarchyAssignment];
  });
  const relationships = ((relationshipsResult.data ?? []) as RelationshipRow[]).map((row) => ({
    subjectAssignmentId: row.subject_assignment_id,
    managerAssignmentId: row.manager_assignment_id
  } satisfies PeopleHierarchyRelationship));

  return {
    byLocation: resolvePeopleOperationalHierarchy(locationIds, assignments, relationships),
    error: null
  };
}
