import "server-only";

import { nlPeopleClusters } from "@/lib/ops-pulse/nl-loss-clusters";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  workforceContactValues,
  type ContactSource,
  type WorkforceConnectContactContext,
  type WorkforceConnectContactPerson,
} from "@/lib/workforce-connect-contacts-core";

type ContactRow = ContactSource & { id: string; full_name?: string | null };
type PersonContact = { profile?: ContactRow | null; source?: ContactRow | null };

async function loadPeopleContacts(companyId: string, personIds: string[]) {
  const contacts = new Map<string, PersonContact>();
  if (!supabaseAdmin || !personIds.length) return contacts;
  const admin = supabaseAdmin;
  const [links, engagements] = await Promise.all([
    admin.from("hr_user_person_links").select("person_id,user_id").eq("company_id", companyId).eq("status", "active").in("person_id", personIds),
    admin.from("hr_engagements").select("person_id,worker_type,employee_id,contractor_id").eq("company_id", companyId).eq("status", "active").in("person_id", personIds),
  ]);
  if (links.error || engagements.error) return contacts;

  const userIds = [...new Set((links.data ?? []).map(row => row.user_id).filter(Boolean))];
  const employeeIds = [...new Set((engagements.data ?? []).map(row => row.employee_id).filter(Boolean))];
  const contractorIds = [...new Set((engagements.data ?? []).map(row => row.contractor_id).filter(Boolean))];
  const [profiles, employees, contractors] = await Promise.all([
    userIds.length ? admin.from("profiles").select("id,full_name,mobile,mobile_country_code,email").eq("company_id", companyId).in("id", userIds) : Promise.resolve({ data: [] as ContactRow[], error: null }),
    employeeIds.length ? admin.from("employees").select("id,full_name,mobile,mobile_country_code,email").eq("company_id", companyId).in("id", employeeIds) : Promise.resolve({ data: [] as ContactRow[], error: null }),
    contractorIds.length ? admin.from("contractors").select("id,full_name,mobile,mobile_country_code,email").eq("company_id", companyId).in("id", contractorIds) : Promise.resolve({ data: [] as ContactRow[], error: null }),
  ]);
  if (profiles.error || employees.error || contractors.error) return contacts;

  const profileById = new Map((profiles.data ?? []).map(row => [row.id, row]));
  const employeeById = new Map((employees.data ?? []).map(row => [row.id, row]));
  const contractorById = new Map((contractors.data ?? []).map(row => [row.id, row]));
  for (const link of links.data ?? []) {
    const current = contacts.get(link.person_id) ?? {};
    current.profile = profileById.get(link.user_id) ?? null;
    contacts.set(link.person_id, current);
  }
  for (const engagement of engagements.data ?? []) {
    const current = contacts.get(engagement.person_id) ?? {};
    current.source = engagement.worker_type === "employee"
      ? employeeById.get(engagement.employee_id) ?? null
      : engagement.worker_type === "contractor"
        ? contractorById.get(engagement.contractor_id) ?? null
        : null;
    contacts.set(engagement.person_id, current);
  }
  return contacts;
}

async function stationDirectory(companyId: string, locationId: string) {
  if (!supabaseAdmin) throw new Error("Database unavailable");
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, [locationId]);
  if (hierarchy.error) throw new Error(hierarchy.error);
  const operational = hierarchy.byLocation.get(locationId);
  const teamLeads = operational?.stationLeads ?? [];
  const clusterManagers = operational?.clusterManagers ?? [];
  const people = await loadPeopleContacts(companyId, [...new Set([
    ...teamLeads.map(person => person.personId),
    ...clusterManagers.map(person => person.personId),
  ])]);
  const contact = (person: { personId: string; name: string; role: string }): WorkforceConnectContactPerson => {
    const values = people.get(person.personId);
    return workforceContactValues(person.name, person.role, values?.profile, values?.source);
  };
  return {
    clusterName: nlPeopleClusters([{ id: locationId }], hierarchy.byLocation).byStation.get(locationId)?.cluster ?? null,
    teamLeads: teamLeads.map(contact),
    clusterManagers: clusterManagers.map(contact),
  };
}


async function associateContact(companyId: string, caseId: string, name: string, role: string | null) {
  if (!supabaseAdmin) return workforceContactValues(name, role);
  const reporter = await supabaseAdmin.from("communication_case_reporters")
    .select("reporter_profile_type,reporter_account_id")
    .eq("company_id", companyId).eq("case_id", caseId).maybeSingle();
  if (reporter.error || !reporter.data) return workforceContactValues(name, role);
  const table = reporter.data.reporter_profile_type === "worker" ? "helpers"
    : reporter.data.reporter_profile_type === "vendor" ? "vendors" : "workforce";
  const source = await supabaseAdmin.from(table).select("full_name,mobile,mobile_country_code,email")
    .eq("company_id", companyId).eq("id", reporter.data.reporter_account_id).maybeSingle();
  return workforceContactValues(source.data?.full_name || name, role, source.data);
}

/** Call only after the case has passed the scoped Workforce Connect case lookup. */
export async function loadWorkforceConnectContacts(input: {
  companyId: string;
  caseId: string;
  locationId: string | null;
  reporterName: string;
  reporterRole: string | null;
}): Promise<WorkforceConnectContactContext> {
  const [associate, directory] = await Promise.all([
    associateContact(input.companyId, input.caseId, input.reporterName, input.reporterRole)
      .catch(() => workforceContactValues(input.reporterName, input.reporterRole)),
    input.locationId ? stationDirectory(input.companyId, input.locationId).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    associate,
    clusterName: directory?.clusterName ?? null,
    teamLeads: directory?.teamLeads ?? [],
    clusterManagers: directory?.clusterManagers ?? [],
  };
}
