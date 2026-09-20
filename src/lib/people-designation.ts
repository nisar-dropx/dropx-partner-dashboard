import { supabaseAdmin } from "@/lib/supabase-admin";

export type PeopleDesignation = { code: string; name: string; active: boolean };

// Display metadata and preview eligibility only. Never replaces a portal's permission matrix.
export async function loadPeopleDesignations(companyId: string, userIds: string[]) {
  const result = new Map<string, PeopleDesignation>();
  if (!supabaseAdmin || !userIds.length) return result;
  const links = await supabaseAdmin.from("hr_user_person_links")
    .select("user_id,person_id").eq("company_id", companyId).eq("status", "active").in("user_id", userIds);
  if (links.error || !links.data?.length) return result;
  const engagements = await supabaseAdmin.from("hr_engagements")
    .select("id,person_id").eq("company_id", companyId).eq("status", "active")
    .in("person_id", [...new Set(links.data.map(row => row.person_id))]);
  if (engagements.error || !engagements.data?.length) return result;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const assignments = await supabaseAdmin.from("hr_work_assignments")
    .select("engagement_id,position_title,designations(code,name,is_active)")
    .eq("company_id", companyId).eq("is_primary", true)
    .in("engagement_id", engagements.data.map(row => row.id))
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false }).order("id", { ascending: false });
  if (assignments.error) return result;
  const personByEngagement = new Map(engagements.data.map(row => [row.id, row.person_id]));
  const designationByPerson = new Map<string, PeopleDesignation>();
  for (const assignment of assignments.data ?? []) {
    const personId = personByEngagement.get(assignment.engagement_id);
    if (!personId || designationByPerson.has(personId)) continue;
    const d = Array.isArray(assignment.designations) ? assignment.designations[0] : assignment.designations;
    if (d?.name || assignment.position_title) designationByPerson.set(personId, {
      code: String(d?.code ?? "").toUpperCase(), name: d?.name || assignment.position_title,
      active: d?.is_active === true
    });
  }
  for (const link of links.data) {
    const designation = designationByPerson.get(link.person_id);
    if (designation) result.set(link.user_id, designation);
  }
  return result;
}

export function canPreviewPortalUsers(masterOwner: boolean, roleCode: string | null, designation?: PeopleDesignation) {
  return masterOwner || roleCode === "OWNER" || Boolean(designation?.active && designation.code === "FSD");
}
