/**
 * Hand Sreerag P's cluster to Vishal Murali for ALL approval surfaces:
 *   - People managed locations (upcoming routing source of truth)
 *   - Ops / Finance payment_requests
 *   - Pay advances, expense claims, reimbursements
 *   - Roster plans, roster swaps
 *   - Leave / WFH / attendance / business-trip style People workflow steps
 *   - Approval delegations still targeting Sreerag
 *
 * Dry-run by default. APPLY=1 writes.
 *
 *   node scripts/operations/20261112-sreerag-cluster-to-vishal.mjs
 *   APPLY=1 node scripts/operations/20261112-sreerag-cluster-to-vishal.mjs
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
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
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

function uniq(ids) {
  return [...new Set((ids ?? []).filter(Boolean))];
}

async function safeAll(label, runner) {
  try {
    return await runner();
  } catch (error) {
    console.warn(`  skip ${label}:`, error.message);
    return [];
  }
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / COMPANY_SUPABASE_SERVICE_ROLE_KEY");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const REASON =
  "Remapped 2026-11-12: Sreerag cluster approvals → Vishal Murali (full cluster handoff)";
const now = new Date().toISOString();

const profiles = await allRows(
  db
    .from("profiles")
    .select("id,full_name,email,is_active,location_scope_ids")
    .eq("company_id", COMPANY)
    .or(
      "full_name.ilike.%sreerag%,email.ilike.%sreerag%,full_name.ilike.%vishal murali%,email.ilike.%vishalmurali%"
    )
);

const sreeragProfile =
  profiles.find((p) => /sreerag/i.test(`${p.full_name} ${p.email}`) && p.is_active) ||
  profiles.find((p) => /sreerag/i.test(`${p.full_name} ${p.email}`));
const vishalProfile =
  profiles.find((p) => /vishal\s*murali/i.test(p.full_name || "") && p.is_active) ||
  profiles.find((p) => /vishalmurali/i.test(p.email || "") && p.is_active) ||
  profiles.find((p) => /vishal/i.test(`${p.full_name} ${p.email}`) && p.is_active);

if (!sreeragProfile) throw new Error("Sreerag profile not found");
if (!vishalProfile) throw new Error("Vishal Murali profile not found");

const links = await allRows(
  db
    .from("hr_user_person_links")
    .select("user_id,person_id,status")
    .eq("company_id", COMPANY)
    .eq("status", "active")
    .in("user_id", [sreeragProfile.id, vishalProfile.id])
);
const FROM_USER = sreeragProfile.id;
const TO_USER = vishalProfile.id;
const FROM_PERSON = links.find((l) => l.user_id === FROM_USER)?.person_id;
const TO_PERSON = links.find((l) => l.user_id === TO_USER)?.person_id;
if (!FROM_PERSON) throw new Error("Sreerag has no active People link");
if (!TO_PERSON) throw new Error("Vishal has no active People link");

const people = await allRows(
  db
    .from("hr_people")
    .select("id,display_name,status")
    .eq("company_id", COMPANY)
    .in("id", [FROM_PERSON, TO_PERSON])
);

const stations = await allRows(
  db
    .from("stations")
    .select("id,station_code,station_name,cluster,is_active,is_ho")
    .eq("company_id", COMPANY)
    .order("station_code")
);
const stationById = new Map(stations.map((s) => [s.id, s]));
const stationCodes = (ids) =>
  uniq(ids)
    .map((id) => stationById.get(id)?.station_code || id)
    .sort();

const personScopes = await allRows(
  db
    .from("people_person_access_scopes")
    .select("id,person_id,location_scope_ids,has_all_location_access")
    .eq("company_id", COMPANY)
    .in("person_id", [FROM_PERSON, TO_PERSON])
);
const sreeragScope = personScopes.find((s) => s.person_id === FROM_PERSON) || null;
const vishalScope = personScopes.find((s) => s.person_id === TO_PERSON) || null;

const clusterStations = stations.filter(
  (s) => s.is_active !== false && /sreerag/i.test(s.cluster || "")
);
const managedFromPeople = uniq(sreeragScope?.location_scope_ids ?? []);
const transferIds = uniq([...managedFromPeople, ...clusterStations.map((s) => s.id)]);

const roles = await allRows(
  db.from("user_roles").select("id,code,name").eq("company_id", COMPANY).eq("is_active", true)
);
const clmRole = roles.find((r) => r.code === "OPERATIONS_CLM");
if (!clmRole) throw new Error("OPERATIONS_CLM role not found");

const memberships = await allRows(
  db
    .from("company_product_memberships")
    .select(
      "id,user_id,role_id,product_code,is_active,has_all_location_access,location_scope_ids,source_system"
    )
    .eq("company_id", COMPANY)
    .eq("is_active", true)
    .in("user_id", [FROM_USER, TO_USER])
);

const PENDING_STEP = ["pending", "waiting", "queued", "active", "open"];
const OPEN_PAYMENT = async () =>
  allRows(
    db
      .from("payment_requests")
      .select(
        "id,request_no,status,approval_status,location_id,location_code,current_approver_user_id,current_approver_role_id"
      )
      .eq("company_id", COMPANY)
      .eq("current_approver_user_id", FROM_USER)
      .order("created_at", { ascending: false })
  );

const inventory = {
  payment_requests: await safeAll("payment_requests", OPEN_PAYMENT),
  hr_expense_claim_request_assignees: await safeAll("hr_expense_claim_request_assignees", () =>
    allRows(
      db
        .from("hr_expense_claim_request_assignees")
        .select("id,request_id,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .eq("status", "pending")
    )
  ),
  hr_expense_approval_steps: await safeAll("hr_expense_approval_steps", () =>
    allRows(
      db
        .from("hr_expense_approval_steps")
        .select("id,claim_id,step_name,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_pay_advance_steps: await safeAll("hr_pay_advance_steps", () =>
    allRows(
      db
        .from("hr_pay_advance_steps")
        .select("id,request_id,step_name,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_roster_approval_steps: await safeAll("hr_roster_approval_steps", () =>
    allRows(
      db
        .from("hr_roster_approval_steps")
        .select("id,plan_id,stage_type,approver_user_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_roster_plans: await safeAll("hr_roster_plans", () =>
    allRows(
      db
        .from("hr_roster_plans")
        .select("id,name,location_id,status,approver_user_id")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .eq("status", "pending_approval")
    )
  ),
  hr_roster_swap_approval_steps: await safeAll("hr_roster_swap_approval_steps", () =>
    allRows(
      db
        .from("hr_roster_swap_approval_steps")
        .select("id,request_id,step_name,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_roster_swap_requests: await safeAll("hr_roster_swap_requests", () =>
    allRows(
      db
        .from("hr_roster_swap_requests")
        .select("id,status,approver_user_id")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", ["pending_partner", "pending_manager"])
    )
  ),
  hr_leave_approval_steps: await safeAll("hr_leave_approval_steps", () =>
    allRows(
      db
        .from("hr_leave_approval_steps")
        .select("id,request_id,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_wfh_approval_steps: await safeAll("hr_wfh_approval_steps", () =>
    allRows(
      db
        .from("hr_wfh_approval_steps")
        .select("id,request_id,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_business_trip_approval_steps: await safeAll("hr_business_trip_approval_steps", () =>
    allRows(
      db
        .from("hr_business_trip_approval_steps")
        .select("id,request_id,approver_user_id,approver_person_id,status")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
        .in("status", PENDING_STEP)
    )
  ),
  hr_approval_delegations_as_delegate: await safeAll("hr_approval_delegations(delegate)", () =>
    allRows(
      db
        .from("hr_approval_delegations")
        .select("id,approver_person_id,delegate_person_id,workflow_code,is_active,effective_from,effective_to,reason")
        .eq("company_id", COMPANY)
        .eq("delegate_person_id", FROM_PERSON)
        .eq("is_active", true)
    )
  ),
  hr_approval_delegations_as_approver: await safeAll("hr_approval_delegations(approver)", () =>
    allRows(
      db
        .from("hr_approval_delegations")
        .select("id,approver_person_id,delegate_person_id,workflow_code,is_active,effective_from,effective_to,reason")
        .eq("company_id", COMPANY)
        .eq("approver_person_id", FROM_PERSON)
        .eq("is_active", true)
    )
  ),
  hr_pending_manager_approval_emails: await safeAll("hr_pending_manager_approval_emails", () =>
    allRows(
      db
        .from("hr_pending_manager_approval_emails")
        .select("request_id,approver_user_id,workflow,recipient_email")
        .eq("company_id", COMPANY)
        .eq("approver_user_id", FROM_USER)
    )
  )
};

console.log(APPLY ? "APPLY" : "DRY-RUN");
console.log("From Sreerag:", {
  userId: FROM_USER,
  personId: FROM_PERSON,
  name: sreeragProfile.full_name,
  email: sreeragProfile.email,
  peopleName: people.find((p) => p.id === FROM_PERSON)?.display_name
});
console.log("To Vishal:", {
  userId: TO_USER,
  personId: TO_PERSON,
  name: vishalProfile.full_name,
  email: vishalProfile.email,
  peopleName: people.find((p) => p.id === TO_PERSON)?.display_name
});
console.log("Sreerag People managed locations:", stationCodes(managedFromPeople).join(", ") || "(none)");
console.log(
  "stations.cluster = Sreerag:",
  clusterStations.map((s) => s.station_code).sort().join(", ") || "(none)"
);
console.log("Transfer station set:", stationCodes(transferIds).join(", ") || "(none)");
console.log("\nPending approvals currently with Sreerag:");
for (const [table, rows] of Object.entries(inventory)) {
  console.log(`  ${table}: ${rows.length}`);
  for (const row of rows.slice(0, 12)) {
    console.log(
      `    - ${row.request_no || row.id}${row.location_code ? ` · ${row.location_code}` : ""}${row.status ? ` · ${row.status}` : ""}${row.step_name || row.stage_type ? ` · ${row.step_name || row.stage_type}` : ""}${row.workflow_code ? ` · ${row.workflow_code}` : ""}`
    );
  }
  if (rows.length > 12) console.log(`    … +${rows.length - 12} more`);
}

const nextVishalScope = uniq([...(vishalScope?.location_scope_ids ?? []), ...transferIds]);
const nextSreeragScope = uniq(managedFromPeople).filter((id) => !transferIds.includes(id));
console.log("\nPlanned People scope:");
console.log("  Vishal gains:", stationCodes(transferIds).join(", ") || "(none)");
console.log("  Vishal next scope count:", nextVishalScope.length);
console.log("  Sreerag remaining:", stationCodes(nextSreeragScope).join(", ") || "(empty)");

if (!APPLY) {
  console.log("\nDry-run only. Re-run with APPLY=1 to write.");
  process.exit(0);
}

async function updatePendingSteps(table, extra = {}) {
  const rows = inventory[table] || [];
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const payload = {
    approver_user_id: TO_USER,
    ...("approver_person_id" in (rows[0] || {}) ? { approver_person_id: TO_PERSON } : {}),
    ...extra
  };
  // Prefer updated_at when the table has it; ignore if PostgREST rejects.
  const withTs = { ...payload, updated_at: now };
  let result = await db.from(table).update(withTs).eq("company_id", COMPANY).in("id", ids).select("id");
  if (result.error && /updated_at|column/i.test(result.error.message)) {
    result = await db.from(table).update(payload).eq("company_id", COMPANY).in("id", ids).select("id");
  }
  if (result.error) throw new Error(`${table}: ${result.error.message}`);
  console.log(`Updated ${table}:`, (result.data ?? []).length);
  return (result.data ?? []).length;
}

// 1) People managed locations — drives upcoming routing.
if (vishalScope?.id) {
  const updated = await db
    .from("people_person_access_scopes")
    .update({ location_scope_ids: nextVishalScope, has_all_location_access: false })
    .eq("company_id", COMPANY)
    .eq("id", vishalScope.id)
    .select("id,location_scope_ids")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  console.log("Updated Vishal people scope →", stationCodes(updated.data.location_scope_ids).length, "stations");
} else {
  const inserted = await db
    .from("people_person_access_scopes")
    .insert({
      company_id: COMPANY,
      person_id: TO_PERSON,
      location_scope_ids: nextVishalScope,
      has_all_location_access: false
    })
    .select("id")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  console.log("Created Vishal people scope", inserted.data.id);
}

if (sreeragScope?.id) {
  const updated = await db
    .from("people_person_access_scopes")
    .update({ location_scope_ids: nextSreeragScope, has_all_location_access: false })
    .eq("company_id", COMPANY)
    .eq("id", sreeragScope.id)
    .select("id,location_scope_ids")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  console.log(
    "Updated Sreerag people scope →",
    stationCodes(updated.data.location_scope_ids).join(", ") || "(empty)"
  );
}

if (transferIds.length) {
  const reconcile = await db.rpc("reconcile_people_operational_routing", {
    p_company_id: COMPANY,
    p_station_ids: transferIds
  });
  if (reconcile.error) console.warn("reconcile warning:", reconcile.error.message);
  else console.log("Reconciled operational routing for", transferIds.length, "stations");
}

// 2) Portal memberships — Vishal CLM covers the stations; strip from Sreerag.
const opsMemberships = memberships.filter((m) => m.product_code === "operations");
let vishalClm =
  opsMemberships.find((m) => m.user_id === TO_USER && m.role_id === clmRole.id) ||
  opsMemberships.find((m) => m.user_id === TO_USER) ||
  null;

if (vishalClm) {
  const nextMembershipScope = uniq([...(vishalClm.location_scope_ids ?? []), ...transferIds]);
  const updated = await db
    .from("company_product_memberships")
    .update({
      role_id: clmRole.id,
      is_active: true,
      has_all_location_access: false,
      location_scope_ids: nextMembershipScope,
      updated_at: now
    })
    .eq("company_id", COMPANY)
    .eq("id", vishalClm.id)
    .select("id,location_scope_ids")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  console.log("Updated Vishal Ops membership →", stationCodes(updated.data.location_scope_ids).length, "stations");
} else if (transferIds.length) {
  const inserted = await db
    .from("company_product_memberships")
    .insert({
      company_id: COMPANY,
      user_id: TO_USER,
      role_id: clmRole.id,
      product_code: "operations",
      is_active: true,
      has_all_location_access: false,
      location_scope_ids: transferIds,
      source_system: "person_override",
      created_at: now,
      updated_at: now
    })
    .select("id")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  console.log("Created Vishal OPERATIONS_CLM membership", inserted.data.id);
}

for (const membership of memberships.filter((m) => m.user_id === FROM_USER && !m.has_all_location_access)) {
  const before = uniq(membership.location_scope_ids);
  const next = before.filter((id) => !transferIds.includes(id));
  if (next.length === before.length) continue;
  const updated = await db
    .from("company_product_memberships")
    .update({ location_scope_ids: next, updated_at: now })
    .eq("company_id", COMPANY)
    .eq("id", membership.id)
    .select("id,product_code,location_scope_ids")
    .single();
  if (updated.error) throw new Error(updated.error.message);
  console.log(
    `Trimmed Sreerag ${updated.data.product_code} membership`,
    updated.data.id,
    "→",
    stationCodes(updated.data.location_scope_ids).join(", ") || "(empty)"
  );
}

// Profile location scope mirror.
{
  const nextProfileScope = uniq([...(vishalProfile.location_scope_ids ?? []), ...transferIds]);
  const updated = await db
    .from("profiles")
    .update({ location_scope_ids: nextProfileScope, updated_at: now })
    .eq("company_id", COMPANY)
    .eq("id", TO_USER);
  if (updated.error) throw new Error(updated.error.message);
  const sreeragNext = uniq(sreeragProfile.location_scope_ids ?? []).filter((id) => !transferIds.includes(id));
  const trimmed = await db
    .from("profiles")
    .update({ location_scope_ids: sreeragNext, updated_at: now })
    .eq("company_id", COMPANY)
    .eq("id", FROM_USER);
  if (trimmed.error) throw new Error(trimmed.error.message);
  console.log("Updated profile location scopes for Vishal + trimmed Sreerag");
}

// 3) Relabel station.cluster
if (transferIds.length) {
  const clusterUpdate = await db
    .from("stations")
    .update({ cluster: "Vishal" })
    .eq("company_id", COMPANY)
    .in("id", transferIds)
    .ilike("cluster", "sreerag")
    .select("station_code");
  if (clusterUpdate.error) throw new Error(clusterUpdate.error.message);
  console.log(
    "stations.cluster relabeled:",
    (clusterUpdate.data ?? []).map((s) => s.station_code).sort().join(", ") || "(none)"
  );
}

// 4) Remap every pending approval currently with Sreerag → Vishal.
if (inventory.payment_requests.length) {
  const remapped = await db
    .from("payment_requests")
    .update({
      current_approver_user_id: TO_USER,
      current_approver_role_id: clmRole.id,
      current_approver_role_ids: [clmRole.id],
      approval_routing_reason: REASON,
      updated_at: now
    })
    .eq("company_id", COMPANY)
    .in(
      "id",
      inventory.payment_requests.map((r) => r.id)
    )
    .select("request_no");
  if (remapped.error) throw new Error(remapped.error.message);
  console.log(
    "Remapped payment_requests:",
    (remapped.data ?? []).map((r) => r.request_no).join(", ") || String(remapped.data?.length || 0)
  );
}

await updatePendingSteps("hr_expense_claim_request_assignees");
await updatePendingSteps("hr_expense_approval_steps");
await updatePendingSteps("hr_pay_advance_steps");
await updatePendingSteps("hr_roster_approval_steps");
await updatePendingSteps("hr_roster_swap_approval_steps", {
  resolved_via: "fallback",
  fallback_reason: REASON
});
await updatePendingSteps("hr_leave_approval_steps");
await updatePendingSteps("hr_wfh_approval_steps");
await updatePendingSteps("hr_business_trip_approval_steps");

if (inventory.hr_roster_plans.length) {
  const updated = await db
    .from("hr_roster_plans")
    .update({ approver_user_id: TO_USER, updated_at: now })
    .eq("company_id", COMPANY)
    .in(
      "id",
      inventory.hr_roster_plans.map((r) => r.id)
    )
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  console.log("Updated hr_roster_plans:", (updated.data ?? []).length);
}

if (inventory.hr_roster_swap_requests.length) {
  const updated = await db
    .from("hr_roster_swap_requests")
    .update({ approver_user_id: TO_USER, updated_at: now })
    .eq("company_id", COMPANY)
    .in(
      "id",
      inventory.hr_roster_swap_requests.map((r) => r.id)
    )
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
  console.log("Updated hr_roster_swap_requests:", (updated.data ?? []).length);
}

// Delegations: retarget Sreerag-as-delegate → Vishal; move covers where Sreerag
// is the covered approver onto Vishal so future leave/WFH covers stay correct.
for (const row of inventory.hr_approval_delegations_as_delegate) {
  const updated = await db
    .from("hr_approval_delegations")
    .update({
      delegate_person_id: TO_PERSON,
      reason: `${row.reason || ""} · ${REASON}`.trim(),
      updated_at: now
    })
    .eq("company_id", COMPANY)
    .eq("id", row.id)
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
}
if (inventory.hr_approval_delegations_as_delegate.length) {
  console.log(
    "Retargeted delegations where Sreerag was delegate:",
    inventory.hr_approval_delegations_as_delegate.length
  );
}

for (const row of inventory.hr_approval_delegations_as_approver) {
  const updated = await db
    .from("hr_approval_delegations")
    .update({
      approver_person_id: TO_PERSON,
      reason: `${row.reason || ""} · ${REASON}`.trim(),
      updated_at: now
    })
    .eq("company_id", COMPANY)
    .eq("id", row.id)
    .select("id");
  if (updated.error) throw new Error(updated.error.message);
}
if (inventory.hr_approval_delegations_as_approver.length) {
  console.log(
    "Retargeted delegations where Sreerag was covered approver:",
    inventory.hr_approval_delegations_as_approver.length
  );
}

// hr_pending_manager_approval_emails is a view over pending steps — it follows
// the step remaps above and cannot be updated directly.
if (inventory.hr_pending_manager_approval_emails.length) {
  console.log(
    "Pending manager approval email rows will refresh from remapped steps:",
    inventory.hr_pending_manager_approval_emails.length
  );
}

// Final leftover check across key queues.
const leftoverPayments = await allRows(
  db
    .from("payment_requests")
    .select("id,request_no,location_code")
    .eq("company_id", COMPANY)
    .eq("current_approver_user_id", FROM_USER)
);
console.log(
  "Leftover payment approvals on Sreerag:",
  leftoverPayments.length
    ? leftoverPayments.map((r) => `${r.request_no}(${r.location_code || "?"})`).join(", ")
    : "none"
);

console.log("\nDone. Upcoming cluster approvals will resolve to Vishal via People managed locations.");
