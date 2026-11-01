/**
 * Remap pending weekly roster approvals onto People operational chains
 * (LM: Cluster Manager → next → HR; DS: City Manager → next → HR).
 *
 * Default: stations that landed on HR-only around 31 Oct–1 Nov 2026.
 * Dry-run unless APPLY=1.
 *
 *   node --experimental-strip-types scripts/operations/20261101-remap-pending-roster-approvals.mjs
 *   APPLY=1 node --experimental-strip-types scripts/operations/20261101-remap-pending-roster-approvals.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDarkStoreStationRow } from "../../src/lib/ops-pulse/people-review-route.ts";
import { resolveRosterManagerChain } from "../../src/lib/ops-pulse/roster-approval-route.ts";

function loadEnv() {
  const out = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (out[match[1]] == null || out[match[1]] === "") out[match[1]] = value;
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await query.range(offset, offset + 999);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < 1000) return rows;
  }
}

async function loadGraph(db, companyId) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const effective = (query) => query.lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`);
  const [assignments, engagements, people, designations, mappings, relationships, links, profiles, memberships, oversight, stations, managedScopes] = await Promise.all([
    allRows(effective(db.from("hr_work_assignments").select("id,engagement_id,location_id,designation_id,position_title").eq("company_id", companyId).eq("is_primary", true)).order("id")),
    allRows(db.from("hr_engagements").select("id,person_id").eq("company_id", companyId).eq("status", "active").lte("start_date", today).or(`end_date.is.null,end_date.gte.${today}`).order("id")),
    allRows(db.from("hr_people").select("id,display_name").eq("company_id", companyId).eq("status", "active").order("id")),
    allRows(db.from("designations").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("id")),
    allRows(db.from("hr_designation_mappings").select("designation_id,can_be_reporting_manager").eq("company_id", companyId).order("designation_id")),
    allRows(effective(db.from("hr_reporting_relationships").select("id,subject_assignment_id,manager_assignment_id").eq("company_id", companyId).eq("is_primary", true).eq("relationship_type", "solid_line")).order("id")),
    allRows(db.from("hr_user_person_links").select("id,person_id,user_id").eq("company_id", companyId).eq("status", "active").order("id")),
    allRows(db.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true).order("id")),
    allRows(db.from("company_product_memberships").select("id,user_id,has_all_location_access,location_scope_ids").eq("company_id", companyId).eq("product_code", "operations").eq("is_active", true).order("id")),
    allRows(db.from("ops_performance_review_oversight_roles").select("id,match_text").eq("company_id", companyId).eq("is_active", true).eq("tier", "full").order("id")),
    allRows(db.from("stations").select("id,parent_station_id,station_code,station_name,providers(code,name),location_models(code,name)").eq("company_id", companyId).order("id")),
    allRows(db.from("people_person_access_scopes").select("person_id,location_scope_ids").eq("company_id", companyId).order("person_id"))
  ]);
  const managedScopeByPerson = new Map(managedScopes.map((row) => [row.person_id, row.location_scope_ids ?? []]));
  const engagementById = new Map(engagements.map((row) => [row.id, row]));
  const personById = new Map(people.map((row) => [row.id, row]));
  const designationById = new Map(designations.map((row) => [row.id, row]));
  const managerIds = new Set(mappings.filter((row) => row.can_be_reporting_manager).map((row) => row.designation_id));
  const activeUsers = new Set(profiles.map((row) => row.id));
  const normalized = (value) => ` ${value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()} `;
  return {
    people: assignments.flatMap((assignment) => {
      const engagement = engagementById.get(assignment.engagement_id);
      const person = engagement && personById.get(engagement.person_id);
      const designation = designationById.get(assignment.designation_id);
      if (!person || !designation) return [];
      const personLinks = links.filter((link) => link.person_id === person.id && activeUsers.has(link.user_id));
      const access = memberships.filter((membership) => personLinks.some((link) => link.user_id === membership.user_id));
      const label = normalized(`${designation.code} ${designation.name}`);
      return [{
        id: assignment.id,
        personId: person.id,
        name: person.display_name,
        designationId: designation.id,
        code: designation.code ?? "",
        role: designation.name || assignment.position_title || "Reporting manager",
        locationId: assignment.location_id,
        managedScopeIds: managedScopeByPerson.get(person.id) ?? [],
        canManage: managerIds.has(designation.id),
        oversight: oversight.some((row) => row.match_text?.trim() && label.includes(normalized(row.match_text))),
        userIds: [...new Set(personLinks.filter((link) => access.some((membership) => membership.user_id === link.user_id)).map((link) => String(link.user_id)))],
        scopeIds: [...new Set(access.flatMap((membership) => (membership.location_scope_ids ?? [])))],
        allLocations: access.some((membership) => membership.has_all_location_access)
      }];
    }),
    relationships: relationships.map((row) => ({ subjectId: row.subject_assignment_id, managerId: row.manager_assignment_id })),
    parentStationById: new Map(stations.filter((row) => row.parent_station_id).map((row) => [String(row.id), String(row.parent_station_id)])),
    darkStoreStationIds: new Set(stations.filter((row) => isDarkStoreStationRow(row)).map((row) => String(row.id)))
  };
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / COMPANY_SUPABASE_SERVICE_ROLE_KEY");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const STATION_CODES = (process.env.STATION_CODES || "TCD4,TTB3,TTA5,TZC4,TTG9,TCC3,KOZA")
  .split(",")
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);
const MANAGER_LEVELS = 2;

const stations = await db.from("stations").select("id,station_code,station_name").eq("company_id", COMPANY).in("station_code", STATION_CODES);
if (stations.error) throw new Error(stations.error.message);
const stationById = new Map((stations.data ?? []).map((row) => [row.id, row]));
const locationIds = [...stationById.keys()];
if (!locationIds.length) throw new Error(`No stations found for ${STATION_CODES.join(", ")}`);

const plans = await db.from("hr_roster_plans")
  .select("id,name,location_id,status,roster_kind,period_start,period_end,submitted_at,approver_user_id")
  .eq("company_id", COMPANY)
  .eq("status", "pending_approval")
  .in("location_id", locationIds)
  .order("submitted_at", { ascending: true });
if (plans.error) throw new Error(plans.error.message);

const graph = await loadGraph(db, COMPANY);
console.log(`${APPLY ? "APPLY" : "DRY-RUN"} · ${plans.data?.length ?? 0} pending plan(s) at ${STATION_CODES.join(", ")}`);

for (const plan of plans.data ?? []) {
  const station = stationById.get(plan.location_id);
  const resolved = resolveRosterManagerChain(graph, plan.location_id, MANAGER_LEVELS);
  const managerSteps = resolved.chain.map((stage, index) => ({
    company_id: COMPANY,
    plan_id: plan.id,
    stage_no: index + 1,
    stage_type: index === 0 ? "level_1" : "level_2",
    approver_user_id: stage.userId,
    resolved_via: "people_operational_chain",
    status: index === 0 ? "pending" : "waiting"
  }));
  const steps = [
    ...managerSteps,
    {
      company_id: COMPANY,
      plan_id: plan.id,
      stage_no: managerSteps.length + 1,
      stage_type: "hr",
      approver_user_id: null,
      resolved_via: "people_operational_chain",
      status: managerSteps.length ? "waiting" : "pending"
    }
  ];
  const summary = steps.map((step) => {
    if (step.stage_type === "hr") return "HR";
    const person = resolved.chain.find((stage) => stage.userId === step.approver_user_id);
    return person ? `${person.name} (${person.role})` : step.approver_user_id;
  }).join(" → ");

  console.log(`\n${station?.station_code ?? "?"} · ${plan.name}`);
  console.log(`  submitted ${plan.submitted_at ?? "—"} · ${resolved.darkStore ? "Dark Store" : "Last Mile"}`);
  console.log(`  route: ${summary}`);
  if (resolved.error && !resolved.chain.length) console.log(`  note: ${resolved.error}`);

  if (!APPLY) continue;

  const cleared = await db.from("hr_roster_approval_steps").delete().eq("company_id", COMPANY).eq("plan_id", plan.id);
  if (cleared.error) throw new Error(cleared.error.message);
  const inserted = await db.from("hr_roster_approval_steps").insert(steps);
  if (inserted.error) throw new Error(inserted.error.message);
  const firstApprover = managerSteps[0]?.approver_user_id ?? null;
  const updated = await db.from("hr_roster_plans").update({
    approver_user_id: firstApprover,
    updated_at: new Date().toISOString()
  }).eq("company_id", COMPANY).eq("id", plan.id).eq("status", "pending_approval");
  if (updated.error) throw new Error(updated.error.message);
  console.log(`  remapped · first approver ${firstApprover ?? "HR group"}`);
}

console.log(APPLY ? "\nDone." : "\nDry-run only. Re-run with APPLY=1 to write.");
