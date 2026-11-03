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

const env = loadEnv();
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co",
  env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const FLTM = "546becfb-3128-4bbb-bbf3-048548b49c8d";
const HLM = "0a1e5edb-5e55-4777-b1bc-254b82caba1c";
const NH = "2271ea22-862b-424c-8d11-21c45d271fe8";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const { data: roles } = await db.from("user_roles").select("id,code,name").eq("company_id", COMPANY).in("id", [FLTM, HLM, NH]);
console.log("roles", roles);

const { data: page } = await db.from("app_pages").select("id").eq("company_id", COMPANY).eq("code", "payment_approvals").maybeSingle();
const { data: grants } = await db.from("role_page_permissions").select("role_id,can_view,can_edit").eq("company_id", COMPANY).eq("page_id", page.id).in("role_id", [FLTM, HLM, NH]);
console.log("payment_approvals grants", grants);

for (const roleId of [FLTM, HLM, NH]) {
  const code = roles.find((r) => r.id === roleId)?.code;
  const { data: mem } = await db.from("company_product_memberships")
    .select("id,user_id,product_code,is_active,has_all_location_access,role_id")
    .eq("company_id", COMPANY).eq("role_id", roleId).eq("is_active", true);
  const ids = [...new Set((mem || []).map((m) => m.user_id))];
  const { data: profiles } = ids.length
    ? await db.from("profiles").select("id,full_name,email,is_active").eq("company_id", COMPANY).in("id", ids)
    : { data: [] };
  console.log(`\n${code} active memberships (${mem?.length || 0}):`, (profiles || []).map((p) => ({
    id: p.id, name: p.full_name, email: p.email, active: p.is_active,
    products: (mem || []).filter((m) => m.user_id === p.id).map((m) => m.product_code),
  })));

  const { data: legacy } = await db.from("profiles").select("id,full_name,email,is_active").eq("company_id", COMPANY).eq("role_id", roleId).eq("is_active", true);
  console.log(`${code} legacy profile.role_id:`, legacy);

  // leave check for each candidate
  for (const p of profiles || []) {
    const { data: link } = await db.from("hr_user_person_links").select("person_id").eq("company_id", COMPANY).eq("user_id", p.id).eq("status", "active").maybeSingle();
    if (!link?.person_id) { console.log("  ", p.full_name, "no person link"); continue; }
    const { data: eng } = await db.from("hr_engagements").select("employee_id").eq("company_id", COMPANY).eq("person_id", link.person_id);
    const empIds = (eng || []).map((e) => e.employee_id).filter(Boolean);
    let onLeave = false;
    if (empIds.length) {
      const { data: leaves } = await db.from("hr_leave_requests").select("id,start_date,end_date")
        .eq("company_id", COMPANY).in("employee_id", empIds).eq("status", "approved").lte("start_date", today).gte("end_date", today);
      onLeave = (leaves || []).length > 0;
    }
    const { data: cover } = await db.from("hr_approval_delegations").select("delegate_person_id,reason")
      .eq("company_id", COMPANY).eq("approver_person_id", link.person_id).eq("is_active", true)
      .lte("effective_from", today).gte("effective_to", today);
    console.log("  ", p.full_name, { onLeave, cover: cover || [] });
  }
}

// Who processed recent successful company_breakdown at KLZH?
const { data: processed } = await db.from("payment_request_approvals")
  .select("payment_request_id,approver_user_id,approver_role_id,action,created_at,comments")
  .eq("company_id", COMPANY)
  .in("payment_request_id", [
    "64f6ebe6-b914-4f8b-81e6-071bd666d03a",
    "cd29ca29-ac08-4b29-b666-1938ee64e7fb",
    "ae9e5cd1-9520-4579-aabc-deac95602cb8",
  ])
  .order("created_at");
console.log("\nRecent processed KLZH breakdown approval logs", processed);
