/**
 * Audit Adhoc Van (VAN_ADHOC) initial-approver coverage for every active
 * non-HO station, using the same sources payment routing uses:
 *   - payment_head_approval_steps step 1 candidates (CLM/RM/AOM/CM …)
 *   - role must have payment_approvals edit
 *   - org_positions assignment OR operations membership with station scope
 *
 * Also inspects DROPX5026 paid advances / due amounts for Oct vs Nov.
 *
 * Dry-run by default. Remap KLZH → Sreerag CLM Ops scope with APPLY=1.
 *
 *   node scripts/operations/20261103-adhoc-van-approver-audit.mjs
 *   APPLY=1 node scripts/operations/20261103-adhoc-van-approver-audit.mjs
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

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / COMPANY_SUPABASE_SERVICE_ROLE_KEY");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const { data: head, error: headError } = await db
  .from("payment_heads")
  .select("id,code,name")
  .eq("company_id", COMPANY)
  .eq("code", "VAN_ADHOC")
  .eq("is_active", true)
  .maybeSingle();
if (headError) throw new Error(headError.message);
if (!head) throw new Error("VAN_ADHOC payment head not found");

const steps = await allRows(
  db.from("payment_head_approval_steps")
    .select("id,step_order,candidates,is_required")
    .eq("company_id", COMPANY)
    .eq("payment_head_id", head.id)
    .order("step_order")
);
const step1 = steps.find((s) => s.step_order === 1);
if (!step1) throw new Error("VAN_ADHOC has no step_order=1");
const step1Candidates = Array.isArray(step1.candidates) ? step1.candidates : [];
const step1RoleIds = [...new Set(step1Candidates.map((c) => c.role_id).filter(Boolean))];

const roles = await allRows(
  db.from("user_roles").select("id,code,name").eq("company_id", COMPANY).in("id", step1RoleIds)
);
const roleById = new Map(roles.map((r) => [r.id, r]));

const { data: page } = await db.from("app_pages").select("id").eq("company_id", COMPANY).eq("code", "payment_approvals").maybeSingle();
const pageId = page?.id
  ?? (await db.from("app_pages").select("id").eq("code", "payment_approvals").is("company_id", null).maybeSingle()).data?.id;
const editable = new Set();
if (pageId) {
  const grants = await allRows(
    db.from("role_page_permissions").select("role_id,can_edit").eq("company_id", COMPANY).eq("page_id", pageId).in("role_id", step1RoleIds)
  );
  for (const g of grants) if (g.can_edit) editable.add(g.role_id);
}
const routableRoleIds = step1RoleIds.filter((id) => editable.has(id));
console.log("VAN_ADHOC step 1 roles:", step1Candidates.map((c) => `${roleById.get(c.role_id)?.code || c.role_id} (${c.scope})`).join(" → "));
console.log("Roles with payment_approvals edit:", routableRoleIds.map((id) => roleById.get(id)?.code || id).join(", ") || "(none)");

const stations = await allRows(
  db.from("stations")
    .select("id,station_code,station_name,cluster,is_active,location_model_id,location_models(code)")
    .eq("company_id", COMPANY)
    .eq("is_active", true)
    .order("station_code")
);
const operating = stations.filter((s) => {
  const model = Array.isArray(s.location_models) ? s.location_models[0]?.code : s.location_models?.code;
  return model && model !== "HO";
});

const memberships = await allRows(
  db.from("company_product_memberships")
    .select("id,user_id,role_id,has_all_location_access,location_scope_ids,is_active")
    .eq("company_id", COMPANY)
    .eq("product_code", "operations")
    .eq("is_active", true)
    .in("role_id", routableRoleIds.length ? routableRoleIds : step1RoleIds)
);

const profiles = await allRows(
  db.from("profiles").select("id,full_name,is_active,email").eq("company_id", COMPANY).eq("is_active", true)
);
const profileById = new Map(profiles.map((p) => [p.id, p]));

const positions = await allRows(
  db.from("org_positions")
    .select("id,role_id,location_access_mode,location_scope_ids,is_active")
    .eq("company_id", COMPANY)
    .eq("is_active", true)
    .in("role_id", routableRoleIds.length ? routableRoleIds : step1RoleIds)
);
const assignments = positions.length
  ? await allRows(
      db.from("position_assignments")
        .select("id,position_id,profile_id,assignment_type,valid_from,valid_until,is_active")
        .eq("company_id", COMPANY)
        .eq("is_active", true)
        .in("position_id", positions.map((p) => p.id))
    )
  : [];
const positionById = new Map(positions.map((p) => [p.id, p]));

function activeAssignment(a) {
  if (!a.is_active) return false;
  if (a.valid_from && a.valid_from > today) return false;
  if (a.valid_until && a.valid_until < today) return false;
  return true;
}

function coversStation(scopeIds, allLocations, stationId) {
  return Boolean(allLocations || (scopeIds ?? []).includes(stationId));
}

function candidateForStation(stationId) {
  const orderedRoles = (routableRoleIds.length ? routableRoleIds : step1RoleIds)
    .map((roleId) => {
      const configured = step1Candidates.find((c) => c.role_id === roleId);
      return { roleId, scope: configured?.scope || "station" };
    });

  for (const { roleId, scope } of orderedRoles) {
    const rolePositions = positions.filter((p) => p.role_id === roleId && (
      p.location_access_mode === "all_locations" || (p.location_scope_ids ?? []).includes(stationId)
    ));
    for (const pos of rolePositions) {
      const asg = assignments
        .filter((a) => a.position_id === pos.id && activeAssignment(a))
        .sort((a, b) => (a.assignment_type === "acting" ? -1 : 1));
      for (const a of asg) {
        const profile = profileById.get(a.profile_id);
        if (profile?.is_active) {
          return { userId: profile.id, name: profile.full_name, role: roleById.get(roleId)?.code, via: "position" };
        }
      }
    }

    for (const m of memberships.filter((row) => row.role_id === roleId)) {
      const ok = scope === "company"
        ? true
        : coversStation(m.location_scope_ids, m.has_all_location_access, stationId);
      if (!ok) continue;
      const profile = profileById.get(m.user_id);
      if (profile?.is_active) {
        return { userId: profile.id, name: profile.full_name, role: roleById.get(roleId)?.code, via: "membership" };
      }
    }
  }
  return null;
}

const gaps = [];
const covered = [];
for (const station of operating) {
  const hit = candidateForStation(station.id);
  if (hit) covered.push({ code: station.station_code, ...hit });
  else gaps.push({ code: station.station_code, name: station.station_name, cluster: station.cluster });
}

console.log(`\nStations covered: ${covered.length}/${operating.length}`);
console.log(`Stations missing initial Adhoc Van approver: ${gaps.length}`);
if (gaps.length) {
  console.log(gaps.map((g) => `${g.code} (${g.cluster || "no-cluster"})`).join(", "));
}

const klzh = operating.find((s) => s.station_code === "KLZH");
const sreerag = profiles.find((p) => /sreerag/i.test(p.full_name || ""));
console.log("\nKLZH current resolver:", klzh ? candidateForStation(klzh.id) : "station missing");
console.log("Sreerag profile:", sreerag ? { id: sreerag.id, name: sreerag.full_name, email: sreerag.email } : "not found");

const clmRole = roles.find((r) => r.code === "OPERATIONS_CLM");
if (klzh && sreerag && clmRole) {
  const sreeragMemberships = memberships.filter((m) => m.user_id === sreerag.id && m.role_id === clmRole.id);
  console.log("Sreerag CLM ops memberships:", sreeragMemberships.map((m) => ({
    id: m.id,
    all: m.has_all_location_access,
    hasKlzh: coversStation(m.location_scope_ids, m.has_all_location_access, klzh.id),
    scopeCount: (m.location_scope_ids ?? []).length,
  })));
  const sreeragPositions = positions.filter((p) => p.role_id === clmRole.id && (
    p.location_access_mode === "all_locations" || (p.location_scope_ids ?? []).includes(klzh.id)
  ));
  console.log("Sreerag CLM positions covering KLZH:", sreeragPositions.length);

  if (APPLY) {
    let membership = sreeragMemberships[0];
    if (!membership) {
      const anyClm = (await db.from("company_product_memberships")
        .select("id,user_id,role_id,has_all_location_access,location_scope_ids,is_active")
        .eq("company_id", COMPANY).eq("user_id", sreerag.id).eq("product_code", "operations").eq("role_id", clmRole.id)
        .order("is_active", { ascending: false }).limit(1)).data?.[0];
      if (anyClm) {
        membership = anyClm;
      } else {
        const inserted = await db.from("company_product_memberships").insert({
          company_id: COMPANY,
          user_id: sreerag.id,
          role_id: clmRole.id,
          product_code: "operations",
          is_active: true,
          has_all_location_access: false,
          location_scope_ids: [klzh.id],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).select("id,location_scope_ids,has_all_location_access").single();
        if (inserted.error) throw new Error(inserted.error.message);
        membership = inserted.data;
        console.log("Created Sreerag CLM ops membership", membership.id);
      }
    }
    if (!coversStation(membership.location_scope_ids, membership.has_all_location_access, klzh.id)) {
      const next = [...new Set([...(membership.location_scope_ids ?? []), klzh.id])];
      const updated = await db.from("company_product_memberships").update({
        is_active: true,
        location_scope_ids: next,
        updated_at: new Date().toISOString(),
      }).eq("id", membership.id).eq("company_id", COMPANY).select("id,location_scope_ids").single();
      if (updated.error) throw new Error(updated.error.message);
      console.log("Added KLZH to Sreerag CLM ops scope", updated.data.id, "scope size", updated.data.location_scope_ids.length);
    } else {
      console.log("Sreerag CLM already includes KLZH in Ops membership");
    }

    // Re-point open KLZH Adhoc Van requests stuck without approver.
    const open = await allRows(
      db.from("payment_requests")
        .select("id,request_no,approval_status,status,location_code,current_approver_user_id")
        .eq("company_id", COMPANY)
        .eq("payment_head_id", head.id)
        .eq("location_id", klzh.id)
        .in("approval_status", ["NO_APPROVER_CONFIGURED", "DRAFT", "PENDING"])
    );
    const stuck = open.filter((r) => !r.current_approver_user_id || r.approval_status === "NO_APPROVER_CONFIGURED");
    if (stuck.length) {
      const remapped = await db.from("payment_requests").update({
        approval_status: "PENDING",
        current_approver_user_id: sreerag.id,
        current_approver_role_id: clmRole.id,
        current_approver_role_ids: [clmRole.id],
        current_step_order: 1,
        approval_routing_reason: "Remapped: KLZH Adhoc Van initial approver → Sreerag (CLM) Ops scope repair 2026-11-03",
        updated_at: new Date().toISOString(),
      }).eq("company_id", COMPANY).eq("payment_head_id", head.id).eq("location_id", klzh.id)
        .in("id", stuck.map((r) => r.id))
        .select("id,request_no");
      if (remapped.error) throw new Error(remapped.error.message);
      console.log("Remapped open KLZH Adhoc Van requests:", (remapped.data ?? []).map((r) => r.request_no).join(", "));
    } else {
      console.log("No stuck KLZH Adhoc Van requests to remap");
    }
  } else {
    console.log("\nDry-run only. Re-run with APPLY=1 to add KLZH to Sreerag CLM Ops scope and remap stuck requests.");
  }
}

// DROPX5026 advance check
console.log("\n=== DROPX5026 advance recovery ===");
const { data: worker } = await db.from("workforce").select("id,dropx_id,full_name").eq("company_id", COMPANY).eq("dropx_id", "DROPX5026").is("deleted_at", null).maybeSingle();
console.log("Worker:", worker);
if (worker) {
  const advances = await allRows(
    db.from("pay_advances")
      .select("id,amount,paid_at,first_due_period,installments,evidence_type,source_key,bank_reference,provenance")
      .eq("company_id", COMPANY)
      .eq("worker_type", "workforce")
      .eq("worker_id", worker.id)
      .order("paid_at")
  );
  for (const a of advances) {
    const deductions = await allRows(
      db.from("pay_advance_deductions")
        .select("id,period_start,amount,status,target_kind,target_key,source_key")
        .eq("company_id", COMPANY)
        .eq("advance_id", a.id)
        .order("period_start")
    );
    const used = deductions.filter((d) => ["reserved", "confirmed", "waived"].includes(d.status))
      .reduce((sum, d) => sum + Number(d.amount), 0);
    console.log({
      id: a.id,
      source: a.source_key,
      amount: Number(a.amount),
      paid_at: a.paid_at,
      first_due_period: a.first_due_period,
      installments: a.installments,
      evidence: a.evidence_type,
      used,
      pending: Math.max(0, Number(a.amount) - used),
      deductions,
    });
  }
  for (const month of ["2026-10-01", "2026-11-01"]) {
    const due = await db.rpc("pay_advance_due", {
      p_company: COMPANY,
      p_worker_type: "workforce",
      p_worker: worker.id,
      p_period: month,
      p_target_kind: "workforce",
      p_target_key: `${worker.id}:${month}`,
    });
    if (due.error) console.log(month, "due error", due.error.message);
    else console.log(month, "pay_advance_due", due.data);
  }
}
