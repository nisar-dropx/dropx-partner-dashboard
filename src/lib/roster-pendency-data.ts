import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPeopleOperationalHierarchy } from "./people-operational-hierarchy.ts";
import {
  buildRosterPendencySnapshot,
  rosterAgeDays,
  rosterStatusLabel,
  rosterWaitingOn,
  uniqueManagerEmail,
  type RosterPendencyRecipient,
  type RosterPendencyRow,
  type RosterPendencyStatus
} from "./roster-pendency.ts";

type Station = { id: string; station_code: string; station_name: string | null; hide_from_location_list: boolean | null };
type Plan = {
  id: string;
  location_id: string | null;
  period_start: string;
  period_end: string;
  status: string;
  revision_no: number | null;
  submitted_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  planning_channel: string | null;
};
type Step = { plan_id: string; stage_type: string; status: string; stage_no: number };
type Profile = { id: string; full_name: string | null; email: string | null };
type Link = { person_id: string; user_id: string };
type Role = { id: string; code: string; escalation_order: number | null; routes_approvals: boolean | null };
type Responsibility = { station_id: string; responsibility_role_id: string; assignment_id: string | null; assignee_user_id: string | null };

async function allRows<T>(
  query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    rows.push(...((result.data ?? []) as T[]));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("Roster pendency source exceeds report limit.");
}

function isOpsPlan(plan: Plan) {
  return plan.planning_channel == null || plan.planning_channel === "ops";
}

function isReportStation(station: Station) {
  return !station.hide_from_location_list && !/^TEST(?:$|[\s_-])/i.test(station.station_code.trim());
}

function profileEmail(profile: Profile | undefined, domain: string) {
  const email = String(profile?.email ?? "").trim().toLowerCase();
  if (!email || !email.endsWith(`@${domain.toLowerCase()}`)) return null;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  return email;
}

/** Open Ops rosters that still need station/cluster manager attention. */
export async function loadRosterPendency(db: SupabaseClient, companyId: string, date: string, domain: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !domain) throw new Error("Roster reminder configuration is incomplete.");

  const [stations, plans, profiles, links, roles] = await Promise.all([
    allRows<Station>((offset) =>
      db.from("stations").select("id,station_code,station_name,hide_from_location_list")
        .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)
    ),
    allRows<Plan>((offset) =>
      db.from("hr_roster_plans").select("id,location_id,period_start,period_end,status,revision_no,submitted_at,updated_at,created_at,planning_channel")
        .eq("company_id", companyId).in("status", ["draft", "returned", "pending_approval"])
        .order("id").range(offset, offset + 999)
    ),
    allRows<Profile>((offset) =>
      db.from("profiles").select("id,full_name,email").eq("company_id", companyId).eq("is_active", true)
        .order("id").range(offset, offset + 999)
    ),
    allRows<Link>((offset) =>
      db.from("hr_user_person_links").select("person_id,user_id").eq("company_id", companyId).eq("status", "active")
        .order("id").range(offset, offset + 999)
    ),
    allRows<Role>((offset) =>
      db.from("station_responsibility_roles").select("id,code,escalation_order,routes_approvals")
        .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)
    )
  ]);

  const stationById = new Map(stations.filter(isReportStation).map((station) => [station.id, station]));
  const openPlans = plans.filter((plan) => isOpsPlan(plan) && plan.location_id && stationById.has(plan.location_id));
  const planIds = openPlans.map((plan) => plan.id);
  const pendingSteps = planIds.length
    ? await allRows<Step>((offset) =>
      db.from("hr_roster_approval_steps").select("plan_id,stage_type,status,stage_no")
        .eq("company_id", companyId).in("plan_id", planIds).eq("status", "pending")
        .order("id").range(offset, offset + 999)
    )
    : [];
  const pendingStepByPlan = new Map<string, Step>();
  for (const step of pendingSteps) {
    const current = pendingStepByPlan.get(step.plan_id);
    if (!current || Number(step.stage_no) < Number(current.stage_no)) pendingStepByPlan.set(step.plan_id, step);
  }

  const rows: RosterPendencyRow[] = openPlans.map((plan) => {
    const station = stationById.get(String(plan.location_id))!;
    const status = plan.status as RosterPendencyStatus;
    const step = pendingStepByPlan.get(plan.id) ?? null;
    const asOfSource = plan.submitted_at || plan.updated_at || plan.created_at;
    return {
      key: plan.id,
      planId: plan.id,
      stationId: station.id,
      stationCode: station.station_code,
      stationName: station.station_name || station.station_code,
      status,
      statusLabel: rosterStatusLabel(status),
      periodStart: plan.period_start,
      periodEnd: plan.period_end,
      revisionNo: Number(plan.revision_no ?? 1),
      waitingOn: rosterWaitingOn(status, step?.stage_type ?? null),
      ageDays: rosterAgeDays(date, asOfSource),
      submittedAt: plan.submitted_at
    };
  });

  const affectedStationIds = [...new Set(rows.map((row) => row.stationId))];
  if (!affectedStationIds.length) {
    return buildRosterPendencySnapshot({ date, checkedAt: new Date().toISOString(), rows: [], recipients: [], unroutedStationIds: [] });
  }

  const configuredRoles = roles.filter((role) => role.routes_approvals);
  const ownerRoles = configuredRoles.length ? configuredRoles : roles.filter((role) => role.code === "station_manager");
  const now = new Date().toISOString();
  const responsibilities = ownerRoles.length
    ? await allRows<Responsibility>((offset) =>
      db.from("station_responsibility_assignments")
        .select("station_id,responsibility_role_id,assignment_id,assignee_user_id")
        .eq("company_id", companyId).eq("is_primary", true)
        .in("station_id", affectedStationIds)
        .in("responsibility_role_id", ownerRoles.map((role) => role.id))
        .lte("effective_from", now).or(`effective_to.is.null,effective_to.gte.${now}`)
        .order("id").range(offset, offset + 999)
    )
    : [];

  const roleOrder = new Map(ownerRoles.map((role) => [role.id, Number(role.escalation_order ?? 9999)]));
  const stationManagerUserId = new Map<string, string>();
  for (const stationId of affectedStationIds) {
    const owner = responsibilities
      .filter((row) => row.station_id === stationId && row.assignee_user_id)
      .sort((left, right) => (roleOrder.get(left.responsibility_role_id) ?? 9999) - (roleOrder.get(right.responsibility_role_id) ?? 9999))[0];
    if (owner?.assignee_user_id) stationManagerUserId.set(stationId, owner.assignee_user_id);
  }

  const hierarchy = await loadPeopleOperationalHierarchy(companyId, affectedStationIds, {
    includeStationResponsibilities: true,
    asOf: date
  });
  if (hierarchy.error) throw new Error(hierarchy.error);

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const linksByPerson = new Map<string, string[]>();
  for (const link of links) {
    const list = linksByPerson.get(link.person_id) ?? [];
    list.push(link.user_id);
    linksByPerson.set(link.person_id, list);
  }

  const emailForUser = (userId: string) => {
    const profile = profileById.get(userId);
    const email = profileEmail(profile, domain);
    return email ? { email, name: profile?.full_name || email, userId } : null;
  };
  const emailForPerson = (personId: string) => {
    const userIds = linksByPerson.get(personId) ?? [];
    const candidates = userIds.map((userId) => profileById.get(userId)).filter(Boolean) as Profile[];
    const email = uniqueManagerEmail(candidates.map((profile) => profileEmail(profile, domain)));
    if (!email) return null;
    const profile = candidates.find((row) => profileEmail(row, domain) === email)!;
    return { email, name: profile.full_name || email, userId: profile.id };
  };

  const recipients = new Map<string, RosterPendencyRecipient & { roleSet: Set<string>; stationSet: Set<string>; planSet: Set<string> }>();
  const unrouted = new Set<string>();
  const addRecipient = (
    contact: { email: string; name: string } | null,
    role: string,
    stationId: string,
    planKeys: string[]
  ) => {
    if (!contact) return false;
    const current = recipients.get(contact.email) ?? {
      email: contact.email,
      name: contact.name,
      roles: [],
      stationIds: [],
      planKeys: [],
      roleSet: new Set<string>(),
      stationSet: new Set<string>(),
      planSet: new Set<string>()
    };
    current.roleSet.add(role);
    current.stationSet.add(stationId);
    for (const key of planKeys) current.planSet.add(key);
    current.roles = [...current.roleSet];
    current.stationIds = [...current.stationSet];
    current.planKeys = [...current.planSet];
    recipients.set(contact.email, current);
    return true;
  };

  for (const stationId of affectedStationIds) {
    const planKeys = rows.filter((row) => row.stationId === stationId).map((row) => row.key);
    const smUserId = stationManagerUserId.get(stationId);
    const sm = smUserId ? emailForUser(smUserId) : null;
    const graph = hierarchy.byLocation.get(stationId);
    // Same rule as registration digests: skip ambiguous CM ties; one clear person only.
    const cmPersonIds = graph?.hasClusterManagerConflict
      ? []
      : [...new Set((graph?.clusterManagers ?? []).map((person) => person.personId))];
    const cm = cmPersonIds.length === 1 ? emailForPerson(cmPersonIds[0]) : null;
    const routedSm = addRecipient(sm, "Station manager", stationId, planKeys);
    const routedCm = addRecipient(cm, "Cluster manager", stationId, planKeys);
    if (!routedSm && !routedCm) unrouted.add(stationId);
  }

  return buildRosterPendencySnapshot({
    date,
    checkedAt: new Date().toISOString(),
    rows,
    recipients: [...recipients.values()].map(({ roleSet: _r, stationSet: _s, planSet: _p, ...recipient }) => recipient),
    unroutedStationIds: [...unrouted]
  });
}
