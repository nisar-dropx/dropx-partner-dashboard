import type { SupabaseClient } from "@supabase/supabase-js";
import type { CodLocationRow } from "./ops-pulse/cod";

export const adHocOpsRoles = new Set([
  "OPERATIONS_LOCATION", "OPERATIONS_TL", "OPERATIONS_SSA", "OPERATIONS_SIC",
  "OPERATIONS_STM", "OPERATIONS_SM", "OPERATIONS_SRSM", "OPERATIONS_CLM",
  "OPERATIONS_CLUSTER_HEAD", "OPERATIONS_AOM", "OPERATIONS_CM", "OPERATIONS_RM",
  "OPERATIONS_PGM", "OPERATIONS_BH", "OPERATIONS_NH", "OPERATIONS_FLTM"
]);

export type AdHocMailStation = CodLocationRow & { station_email?: string | null };
export type AdHocMailRecipient = { email: string; name: string; stationIds: string[] };
export type AdHocMembership = { user_id: string; role_id: string; has_all_location_access: boolean; location_scope_ids: string[] | null };
export type AdHocRole = { id: string; code: string; location_access_mode: string | null };
export type AdHocProfile = { id: string; full_name: string | null; email: string | null };
type AdHocPersonLink = { id: string; user_id: string; person_id: string; status: string | null };
type AdHocPerson = { id: string; status: string | null };
type AdHocEngagement = { id: string; person_id: string; status: string | null; start_date: string | null; end_date: string | null };
type AdHocAssignment = { id: string; engagement_id: string; department_id: string | null; is_primary: boolean; effective_from: string; effective_to: string | null };
type AdHocDepartment = { id: string; code: string | null; name: string | null; is_active: boolean };

function relationCode(relation: CodLocationRow["providers"]) {
  const row = Array.isArray(relation) ? relation[0] : relation;
  return String(row?.code || "").trim().toUpperCase();
}

export function adHocProgram(station: CodLocationRow) {
  const provider = relationCode(station.providers), model = relationCode(station.location_models);
  if (provider === "AMAZON" && ["EDSP", "XPT"].includes(model)) return `Amazon ${model}`;
  if (provider === "FLIPKART" && ["ODH", "MDH"].includes(model)) return `Flipkart ${model}`;
  return null;
}

function normalizedWords(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export function adHocRegionLabel(station: Pick<CodLocationRow, "region" | "state">) {
  const region = normalizedWords(station.region);
  if (["KL", "KERALA"].includes(region)) return "KL";
  if (["AP", "ANDHRA PRADESH"].includes(region)) return "AP";
  if (["ODCG", "OD CG", "OD", "CG", "ODISHA", "CHHATTISGARH"].includes(region)) return "ODCG";
  const state = normalizedWords(station.state);
  if (["KL", "KERALA"].includes(state)) return "KL";
  if (["AP", "ANDHRA PRADESH"].includes(state)) return "AP";
  if (["ODCG", "OD CG", "OD", "CG", "ODISHA", "CHHATTISGARH"].includes(state)) return "ODCG";
  return "Unassigned";
}

export function isAdHocMailStation(station: CodLocationRow) {
  return Boolean(adHocProgram(station))
    && !/^TEST(?:$|[\s_-])/i.test(String(station.station_code ?? "").trim())
    && adHocRegionLabel(station) !== "Unassigned";
}

export function resolveAdHocRecipients(
  stations: AdHocMailStation[], memberships: AdHocMembership[], roles: AdHocRole[],
  profiles: AdHocProfile[], domain: string, operationsUserIds: ReadonlySet<string> = new Set()
): AdHocMailRecipient[] {
  const allowedStations = stations.filter(station => !station.hide_from_location_list && isAdHocMailStation(station));
  const roleById = new Map(roles.filter(role => adHocOpsRoles.has(role.code)).map(role => [role.id, role]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const recipients = new Map<string, AdHocMailRecipient>();
  for (const membership of memberships) {
    const role = roleById.get(membership.role_id), profile = profileById.get(membership.user_id);
    const email = String(profile?.email || "").trim().toLowerCase();
    if (!role || !profile || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.split("@")[1] !== domain.toLowerCase()) continue;
    const locationMailbox = role.code === "OPERATIONS_LOCATION";
    if (!locationMailbox && !operationsUserIds.has(profile.id)) continue;
    const scoped = allowedStations.filter(station => locationMailbox
      ? station.station_email?.trim().toLowerCase() === email
      : membership.has_all_location_access || role.location_access_mode === "all_locations" || membership.location_scope_ids?.includes(station.id));
    if (!scoped.length) continue;
    const recipient = recipients.get(email) ?? { email, name: profile.full_name || email, stationIds: [] };
    recipient.stationIds = [...new Set([...recipient.stationIds, ...scoped.map(station => station.id)])].sort();
    recipients.set(email, recipient);
  }
  return [...recipients.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// Page every source; a capped recipient list must never silently omit a station team.
async function allRows<T>(query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 30000; offset += 1000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []) as T[]);
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("Ad hoc recipient scope exceeds the supported size.");
}

export async function loadAdHocMailScope(db: SupabaseClient, companyId: string, domain: string) {
  const [stations, memberships, roles, profiles, personLinks, people, engagements, assignments, departments] = await Promise.all([
    allRows<AdHocMailStation>(offset => db.from("stations")
      .select("id,station_code,station_name,station_email,state,region,cluster,cluster_manager,aom,hide_from_location_list,providers(code,name),location_models(code,name)")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocMembership>(offset => db.from("company_product_memberships")
      .select("user_id,role_id,has_all_location_access,location_scope_ids")
      .eq("company_id", companyId).eq("product_code", "operations").eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocRole>(offset => db.from("user_roles").select("id,code,location_access_mode")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocProfile>(offset => db.from("profiles").select("id,full_name,email")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocPersonLink>(offset => db.from("hr_user_person_links").select("id,user_id,person_id,status")
      .eq("company_id", companyId).order("id").range(offset, offset + 999)),
    allRows<AdHocPerson>(offset => db.from("hr_people").select("id,status")
      .eq("company_id", companyId).order("id").range(offset, offset + 999)),
    allRows<AdHocEngagement>(offset => db.from("hr_engagements").select("id,person_id,status,start_date,end_date")
      .eq("company_id", companyId).order("id").range(offset, offset + 999)),
    allRows<AdHocAssignment>(offset => db.from("hr_work_assignments").select("id,engagement_id,department_id,is_primary,effective_from,effective_to")
      .eq("company_id", companyId).order("id").range(offset, offset + 999)),
    allRows<AdHocDepartment>(offset => db.from("hr_departments").select("id,code,name,is_active")
      .eq("company_id", companyId).order("id").range(offset, offset + 999))
  ]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const activePeople = new Set(people.filter(person => String(person.status).toLowerCase() === "active").map(person => person.id));
  const activeEngagements = new Set(engagements.filter(engagement => activePeople.has(engagement.person_id)
    && String(engagement.status).toLowerCase() === "active"
    && (!engagement.start_date || engagement.start_date <= today)
    && (!engagement.end_date || engagement.end_date >= today)).map(engagement => engagement.id));
  const operationsDepartments = new Set(departments.filter(department => department.is_active
    && (normalizedWords(department.code) === "OPS" || normalizedWords(department.name) === "OPERATIONS")).map(department => department.id));
  const operationsEngagements = new Set(assignments.filter(assignment => assignment.is_primary
    && activeEngagements.has(assignment.engagement_id)
    && Boolean(assignment.department_id && operationsDepartments.has(assignment.department_id))
    && assignment.effective_from <= today
    && (!assignment.effective_to || assignment.effective_to >= today)).map(assignment => assignment.engagement_id));
  const operationsPeople = new Set(engagements.filter(engagement => operationsEngagements.has(engagement.id)).map(engagement => engagement.person_id));
  const operationsUserIds = new Set(personLinks.filter(link => String(link.status).toLowerCase() === "active" && operationsPeople.has(link.person_id)).map(link => link.user_id));
  const unassignedRegions = stations.filter(station => !station.hide_from_location_list && adHocProgram(station)
    && !/^TEST(?:$|[\s_-])/i.test(String(station.station_code ?? "").trim())
    && adHocRegionLabel(station) === "Unassigned");
  if (unassignedRegions.length) throw new Error(`Ad hoc stations have no KL/AP/ODCG region: ${unassignedRegions.map(station => station.station_code).join(", ")}`);
  const included = stations.filter(station => !station.hide_from_location_list && isAdHocMailStation(station));
  return { stations: included, recipients: resolveAdHocRecipients(included, memberships, roles, profiles, domain, operationsUserIds) };
}
