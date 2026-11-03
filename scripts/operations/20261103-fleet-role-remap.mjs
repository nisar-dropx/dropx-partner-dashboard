/**
 * Diagnose missing OPERATIONS_FLTM holders and propose remap of
 * company_breakdown / breakdown_vehicle adhoc steps to an active Fleet role.
 *
 * Dry-run by default. APPLY=1 updates fleet_adhoc_reason_rules and remaps
 * open NO_APPROVER_CONFIGURED company_breakdown requests to the new step-1 owner.
 *
 *   node scripts/operations/20261103-fleet-role-remap.mjs
 *   APPLY=1 node scripts/operations/20261103-fleet-role-remap.mjs
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
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (out[match[1]] == null || out[match[1]] === "") out[match[1]] = value;
      }
    } catch { /* optional */ }
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
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co",
  env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const FLTM = "546becfb-3128-4bbb-bbf3-048548b49c8d";
const priorApprover = "da5a074f-d66e-4f68-82e6-7939b6083cc9";
const priorRole = "e1dc5c0a-3a60-4000-9f00-1c0a1cf97cc7";

const { data: priorProfile } = await db.from("profiles").select("id,full_name,email,is_active,role_id").eq("id", priorApprover).maybeSingle();
const { data: priorRoleRow } = await db.from("user_roles").select("id,code,name").eq("id", priorRole).maybeSingle();
console.log("Recent breakdown first approver was", priorProfile, "role", priorRoleRow);

const priorMemberships = await allRows(
  db.from("company_product_memberships").select("id,product_code,role_id,is_active,has_all_location_access")
    .eq("company_id", COMPANY).eq("user_id", priorApprover)
);
console.log("Their memberships", priorMemberships);

const fleetRoles = await allRows(
  db.from("user_roles").select("id,code,name").eq("company_id", COMPANY).or("code.ilike.%FLEET%,code.eq.OPERATIONS_FLTM,name.ilike.%Fleet%")
);
console.log("Fleet-like roles", fleetRoles);

for (const role of fleetRoles) {
  const mem = await allRows(
    db.from("company_product_memberships").select("user_id,product_code,is_active,role_id")
      .eq("company_id", COMPANY).eq("role_id", role.id).eq("is_active", true)
  );
  const ids = [...new Set(mem.map((m) => m.user_id))];
  const { data: people } = ids.length
    ? await db.from("profiles").select("id,full_name,email,is_active").eq("company_id", COMPANY).in("id", ids)
    : { data: [] };
  console.log(role.code, "active holders", people);
}

// Prefer: restore FLTM onto the person who was approving, if still active.
// Else use active FLEET_BH / FLEET_HLM holders.
let targetRoleId = FLTM;
let targetUserId = priorProfile?.is_active ? priorApprover : null;
let targetName = priorProfile?.full_name;

if (!targetUserId) {
  const preferredCodes = ["FLEET_BH", "FLEET_HLM", "OPERATIONS_FLTM", "FLEET_MANAGER"];
  for (const code of preferredCodes) {
    const role = fleetRoles.find((r) => r.code === code);
    if (!role) continue;
    const mem = await allRows(
      db.from("company_product_memberships").select("user_id").eq("company_id", COMPANY).eq("role_id", role.id).eq("is_active", true)
    );
    if (!mem.length) continue;
    const { data: person } = await db.from("profiles").select("id,full_name,is_active").eq("id", mem[0].user_id).maybeSingle();
    if (person?.is_active) {
      targetRoleId = role.id;
      targetUserId = person.id;
      targetName = person.full_name;
      break;
    }
  }
}

console.log("\nProposed step-1 owner", { targetUserId, targetName, targetRoleId });

const { data: page } = await db.from("app_pages").select("id").eq("company_id", COMPANY).eq("code", "payment_approvals").maybeSingle();
const { data: grant } = await db.from("role_page_permissions").select("can_edit").eq("company_id", COMPANY).eq("page_id", page.id).eq("role_id", targetRoleId).maybeSingle();
console.log("Target role payment_approvals edit?", grant);

const rules = await allRows(
  db.from("fleet_adhoc_reason_rules").select("company_id,reason_key,label,approval_steps")
    .eq("company_id", COMPANY).in("reason_key", ["company_breakdown", "breakdown_vehicle"])
);
for (const rule of rules) {
  console.log(rule.reason_key, "current step1", rule.approval_steps?.[0]);
}

if (!targetUserId) {
  console.error("No active Fleet approver found to remap onto. Aborting.");
  process.exit(1);
}

if (!APPLY) {
  console.log("\nDry-run. APPLY=1 will:");
  console.log("1) Ensure target user has active membership on target role (operations or fleet product)");
  console.log("2) Point company_breakdown + breakdown_vehicle step 1 at that role");
  console.log("3) Remap open NO_APPROVER company_breakdown requests to that user");
  process.exit(0);
}

// Ensure membership: prefer fleet product for FLEET_* roles, operations for OPERATIONS_FLTM
const product = String(fleetRoles.find((r) => r.id === targetRoleId)?.code || "").startsWith("FLEET") ? "fleet" : "operations";
const existing = await allRows(
  db.from("company_product_memberships").select("id,role_id,product_code,is_active")
    .eq("company_id", COMPANY).eq("user_id", targetUserId).eq("product_code", product)
);
const activeSame = existing.find((m) => m.role_id === targetRoleId && m.is_active);
if (!activeSame) {
  if (existing[0]) {
    const updated = await db.from("company_product_memberships").update({
      role_id: targetRoleId,
      is_active: true,
      updated_at: new Date().toISOString(),
    }).eq("id", existing[0].id).select("id,role_id,product_code").single();
    if (updated.error) throw new Error(updated.error.message);
    console.log("Updated membership", updated.data);
  } else {
    // also ensure OPERATIONS_FLTM membership if remapping rule to FLTM and prior user only has other product
    const inserted = await db.from("company_product_memberships").insert({
      company_id: COMPANY,
      user_id: targetUserId,
      role_id: targetRoleId,
      product_code: product,
      is_active: true,
      has_all_location_access: true,
      location_scope_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select("id,role_id,product_code").single();
    if (inserted.error) throw new Error(inserted.error.message);
    console.log("Created membership", inserted.data);
  }
} else {
  console.log("Membership already active", activeSame.id);
}

// Also ensure OPERATIONS_FLTM membership exists if rules still use FLTM role id
if (targetRoleId === FLTM) {
  const opsFltm = await allRows(
    db.from("company_product_memberships").select("id,is_active")
      .eq("company_id", COMPANY).eq("user_id", targetUserId).eq("role_id", FLTM).eq("product_code", "operations")
  );
  if (!opsFltm.some((m) => m.is_active)) {
    if (opsFltm[0]) {
      await db.from("company_product_memberships").update({ is_active: true, has_all_location_access: true, updated_at: new Date().toISOString() }).eq("id", opsFltm[0].id);
    } else {
      await db.from("company_product_memberships").insert({
        company_id: COMPANY,
        user_id: targetUserId,
        role_id: FLTM,
        product_code: "operations",
        is_active: true,
        has_all_location_access: true,
        location_scope_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    console.log("Ensured operations FLTM membership for", targetName);
  }
}

for (const rule of rules) {
  const steps = Array.isArray(rule.approval_steps) ? structuredClone(rule.approval_steps) : [];
  if (!steps.length) continue;
  const step1 = steps.find((s) => s.step_order === 1) || steps[0];
  step1.candidates = [{ role_id: targetRoleId, scope: "company" }];
  const updated = await db.from("fleet_adhoc_reason_rules").update({ approval_steps: steps })
    .eq("company_id", COMPANY).eq("reason_key", rule.reason_key)
    .select("reason_key").single();
  if (updated.error) throw new Error(updated.error.message);
  console.log("Updated rule", updated.data.reason_key);
}

const { data: head } = await db.from("payment_heads").select("id").eq("company_id", COMPANY).eq("code", "VAN_ADHOC").maybeSingle();
const stuck = await allRows(
  db.from("payment_requests").select("id,request_no,adhoc_approval_steps,location_code")
    .eq("company_id", COMPANY).eq("payment_head_id", head.id)
    .eq("approval_status", "NO_APPROVER_CONFIGURED")
    .eq("adhoc_reason_key", "company_breakdown")
);

for (const req of stuck) {
  const steps = Array.isArray(req.adhoc_approval_steps) ? structuredClone(req.adhoc_approval_steps) : [];
  const step1 = steps.find((s) => s.step_order === 1) || steps[0];
  if (step1) step1.candidates = [{ role_id: targetRoleId, scope: "company" }];
  const updated = await db.from("payment_requests").update({
    adhoc_approval_steps: steps.length ? steps : req.adhoc_approval_steps,
    approval_status: "PENDING",
    current_step_order: 1,
    current_approver_user_id: targetUserId,
    current_approver_role_id: targetRoleId,
    current_approver_role_ids: [targetRoleId],
    approval_routing_reason: `Remapped 2026-11-03: company_breakdown Fleet step → ${targetName} (missing OPERATIONS_FLTM holders)`,
    updated_at: new Date().toISOString(),
  }).eq("company_id", COMPANY).eq("id", req.id).select("request_no,location_code").single();
  if (updated.error) throw new Error(updated.error.message);
  console.log("Remapped request", updated.data);
}

console.log("Done.");
