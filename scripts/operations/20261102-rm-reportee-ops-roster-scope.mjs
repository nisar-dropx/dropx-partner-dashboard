/**
 * Grant Regional Managers OpsPulse station scope for their direct People reportees
 * (City Managers posted at HO_TS etc. whose Ops scopes hold the field stores),
 * so Rostering can edit those stations.
 *
 * Updates:
 *   - company_product_memberships (operations)
 *   - people_person_access_scopes
 *
 * Dry-run unless APPLY=1.
 *
 *   node --experimental-strip-types scripts/operations/20261102-rm-reportee-ops-roster-scope.mjs
 *   APPLY=1 node --experimental-strip-types scripts/operations/20261102-rm-reportee-ops-roster-scope.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

function isRmDesignation(code, name) {
  const normalizedCode = String(code ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  const normalizedName = ` ${String(name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  return normalizedCode === "RM"
    || normalizedCode === "RH"
    || normalizedCode === "REGIONAL_MANAGER"
    || normalizedCode === "REGIONAL_HEAD"
    || /\b(REGIONAL MANAGER|REGIONAL HEAD)\b/.test(normalizedName);
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / COMPANY_SUPABASE_SERVICE_ROLE_KEY");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const designations = await allRows(
  db.from("designations").select("id,code,name").eq("company_id", COMPANY).eq("is_active", true).order("id")
);
const rmDesignationIds = new Set(
  designations.filter((row) => isRmDesignation(row.code, row.name)).map((row) => row.id)
);
if (!rmDesignationIds.size) throw new Error("No Regional Manager designations found");

const assignments = await allRows(
  db.from("hr_work_assignments").select("id,engagement_id,designation_id,location_id")
    .eq("company_id", COMPANY).eq("is_primary", true)
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).order("id")
);
const engagements = await allRows(
  db.from("hr_engagements").select("id,person_id,status")
    .eq("company_id", COMPANY).eq("status", "active")
    .lte("start_date", today).or(`end_date.is.null,end_date.gte.${today}`).order("id")
);
const people = await allRows(
  db.from("hr_people").select("id,display_name").eq("company_id", COMPANY).eq("status", "active").order("id")
);
const links = await allRows(
  db.from("hr_user_person_links").select("person_id,user_id").eq("company_id", COMPANY).eq("status", "active").order("user_id")
);
const relationships = await allRows(
  db.from("hr_reporting_relationships").select("subject_assignment_id,manager_assignment_id")
    .eq("company_id", COMPANY).eq("is_primary", true).eq("relationship_type", "solid_line")
    .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).order("id")
);
const memberships = await allRows(
  db.from("company_product_memberships").select("id,user_id,location_scope_ids,has_all_location_access,is_active,product_code")
    .eq("company_id", COMPANY).eq("product_code", "operations").eq("is_active", true).order("id")
);
const personScopes = await allRows(
  db.from("people_person_access_scopes").select("id,person_id,location_scope_ids,has_all_location_access")
    .eq("company_id", COMPANY).order("person_id")
);
const stations = await allRows(
  db.from("stations").select("id,station_code,is_ho").eq("company_id", COMPANY).order("station_code")
);

const personById = new Map(people.map((row) => [row.id, row]));
const engagementById = new Map(engagements.map((row) => [row.id, row]));
const assignmentById = new Map(assignments.map((row) => [row.id, row]));
const stationById = new Map(stations.map((row) => [row.id, row]));
const linksByPerson = new Map();
for (const link of links) {
  const list = linksByPerson.get(link.person_id) ?? [];
  list.push(link.user_id);
  linksByPerson.set(link.person_id, list);
}
const membershipsByUser = new Map();
for (const membership of memberships) {
  const list = membershipsByUser.get(membership.user_id) ?? [];
  list.push(membership);
  membershipsByUser.set(membership.user_id, list);
}
const personScopeByPerson = new Map(personScopes.map((row) => [row.person_id, row]));
const subjectsByManager = new Map();
for (const edge of relationships) {
  const list = subjectsByManager.get(edge.manager_assignment_id) ?? [];
  list.push(edge.subject_assignment_id);
  subjectsByManager.set(edge.manager_assignment_id, list);
}

function stationCodes(ids) {
  return [...ids].map((id) => stationById.get(id)?.station_code ?? id).sort();
}

function collectReporteeStations(managerAssignmentId) {
  const ids = new Set();
  const reporteeNames = [];
  for (const subjectId of subjectsByManager.get(managerAssignmentId) ?? []) {
    const subject = assignmentById.get(subjectId);
    if (!subject) continue;
    const engagement = engagementById.get(subject.engagement_id);
    if (!engagement || engagement.status !== "active") continue;
    const person = personById.get(engagement.person_id);
    if (!person) continue;
    reporteeNames.push(person.display_name);
    if (subject.location_id) ids.add(subject.location_id);
    const managed = personScopeByPerson.get(person.id);
    for (const locationId of managed?.location_scope_ids ?? []) ids.add(locationId);
    for (const userId of linksByPerson.get(person.id) ?? []) {
      for (const membership of membershipsByUser.get(userId) ?? []) {
        if (membership.has_all_location_access) continue;
        for (const locationId of membership.location_scope_ids ?? []) ids.add(locationId);
      }
    }
  }
  return { ids, reporteeNames: [...new Set(reporteeNames)].sort() };
}

const rmAssignments = assignments.filter((row) => rmDesignationIds.has(row.designation_id));
console.log(`${APPLY ? "APPLY" : "DRY-RUN"} · ${rmAssignments.length} Regional Manager assignment(s)`);

let changedMemberships = 0;
let changedPeopleScopes = 0;

for (const assignment of rmAssignments) {
  const engagement = engagementById.get(assignment.engagement_id);
  if (!engagement) continue;
  const person = personById.get(engagement.person_id);
  if (!person) continue;
  const { ids: needed, reporteeNames } = collectReporteeStations(assignment.id);
  if (!needed.size) {
    console.log(`\n${person.display_name}: no reportee stations`);
    continue;
  }

  const userIds = linksByPerson.get(person.id) ?? [];
  console.log(`\n${person.display_name}`);
  console.log(`  reportees: ${reporteeNames.join(", ") || "—"}`);
  console.log(`  needed stations: ${stationCodes(needed).join(", ")}`);

  for (const userId of userIds) {
    for (const membership of membershipsByUser.get(userId) ?? []) {
      if (membership.has_all_location_access) {
        console.log(`  membership ${membership.id}: all-locations (skip)`);
        continue;
      }
      const current = new Set(membership.location_scope_ids ?? []);
      const missing = [...needed].filter((id) => !current.has(id));
      if (!missing.length) {
        console.log(`  membership ${membership.id}: already covers reportees`);
        continue;
      }
      const next = [...new Set([...current, ...needed])];
      console.log(`  membership ${membership.id}: +${stationCodes(missing).join(", ")}`);
      if (!APPLY) continue;
      const updated = await db.from("company_product_memberships")
        .update({ location_scope_ids: next, updated_at: new Date().toISOString() })
        .eq("company_id", COMPANY)
        .eq("id", membership.id);
      if (updated.error) throw new Error(updated.error.message);
      changedMemberships += 1;
      membership.location_scope_ids = next;
    }
  }

  const existingScope = personScopeByPerson.get(person.id);
  const currentPeople = new Set(existingScope?.location_scope_ids ?? []);
  const missingPeople = [...needed].filter((id) => !currentPeople.has(id));
  if (!missingPeople.length) {
    console.log("  people scope: already covers reportees");
  } else {
    const nextPeople = [...new Set([...currentPeople, ...needed])];
    console.log(`  people scope: +${stationCodes(missingPeople).join(", ")}`);
    if (APPLY) {
      if (existingScope?.id) {
        const updated = await db.from("people_person_access_scopes")
          .update({ location_scope_ids: nextPeople })
          .eq("company_id", COMPANY)
          .eq("id", existingScope.id);
        if (updated.error) throw new Error(updated.error.message);
      } else {
        const inserted = await db.from("people_person_access_scopes").insert({
          company_id: COMPANY,
          person_id: person.id,
          location_scope_ids: nextPeople,
          has_all_location_access: false
        });
        if (inserted.error) throw new Error(inserted.error.message);
      }
      changedPeopleScopes += 1;
    }
  }
}

console.log(APPLY
  ? `\nDone. Updated memberships=${changedMemberships}, people scopes=${changedPeopleScopes}.`
  : "\nDry-run only. Re-run with APPLY=1 to write.");
