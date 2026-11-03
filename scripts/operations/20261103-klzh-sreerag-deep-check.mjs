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
const sreerag = "53216c47-1e77-4314-8e8c-e6b177df6751";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const { data: klzh } = await db.from("stations").select("id,station_code,location_model_id").eq("company_id", COMPANY).eq("station_code", "KLZH").maybeSingle();
const { data: head } = await db.from("payment_heads").select("id").eq("company_id", COMPANY).eq("code", "VAN_ADHOC").maybeSingle();
const open = await db.from("payment_requests")
  .select("id,request_no,status,approval_status,current_approver_user_id,current_approver_role_id,adhoc_reason_key,adhoc_approval_steps,approval_routing_reason,created_at,updated_at")
  .eq("company_id", COMPANY).eq("payment_head_id", head.id).eq("location_id", klzh.id)
  .order("created_at", { ascending: false }).limit(10);
console.log("KLZH Adhoc requests", JSON.stringify(open.data, null, 2));

const excl = await db.from("payment_approver_exclusions").select("*").eq("company_id", COMPANY).eq("profile_id", sreerag).eq("is_active", true);
console.log("exclusions", excl.error?.message || excl.data);

const link = await db.from("hr_user_person_links").select("person_id").eq("company_id", COMPANY).eq("user_id", sreerag).eq("status", "active").maybeSingle();
console.log("person link", link.data);
if (link.data?.person_id) {
  const eng = await db.from("hr_engagements").select("employee_id,contractor_id").eq("company_id", COMPANY).eq("person_id", link.data.person_id);
  console.log("engagements", eng.data);
  const empIds = (eng.data || []).map((e) => e.employee_id).filter(Boolean);
  const contractorIds = (eng.data || []).map((e) => e.contractor_id).filter(Boolean);
  if (empIds.length) {
    const leaves = await db.from("hr_leave_requests").select("id,status,start_date,end_date,employee_id")
      .eq("company_id", COMPANY).in("employee_id", empIds).eq("status", "approved").lte("start_date", today).gte("end_date", today);
    console.log("active leaves", leaves.data);
  }
  if (contractorIds.length) {
    const leaves = await db.from("hr_leave_requests").select("id,status,start_date,end_date,contractor_id")
      .eq("company_id", COMPANY).in("contractor_id", contractorIds).eq("status", "approved").lte("start_date", today).gte("end_date", today);
    console.log("active contractor leaves", leaves.data);
  }
  const trips = await db.from("hr_business_trip_requests").select("id,status,start_date,end_date")
    .eq("company_id", COMPANY).eq("person_id", link.data.person_id).eq("status", "approved").lte("start_date", today).gte("end_date", today);
  console.log("active trips", trips.data);
  const cover = await db.from("hr_approval_delegations").select("*")
    .eq("company_id", COMPANY).eq("approver_person_id", link.data.person_id).eq("is_active", true)
    .lte("effective_from", today).gte("effective_to", today);
  console.log("active cover", cover.data);
}

const roles = await db.from("user_roles").select("id,code").eq("company_id", COMPANY)
  .in("code", ["OPERATIONS_CLM", "OPERATIONS_FLTM", "OPERATIONS_HLM", "OPERATIONS_BH", "OPERATIONS_NH", "OPERATIONS_AOM", "OPERATIONS_CM", "OPERATIONS_RM"]);
const roleCode = Object.fromEntries((roles.data || []).map((r) => [r.id, r.code]));
const rules = await db.from("fleet_adhoc_reason_rules").select("reason_key,label,approval_steps,is_active").eq("company_id", COMPANY).eq("is_active", true).order("sort_order");
console.log("adhoc rules", (rules.data || []).map((r) => ({
  key: r.reason_key,
  label: r.label,
  steps: (r.approval_steps || []).map((s) => ({
    order: s.step_order,
    required: s.is_required,
    roles: (s.candidates || []).map((c) => `${roleCode[c.role_id] || c.role_id}:${c.scope}`),
  })),
})));

// Gap stations: who should People say owns them?
const gapCodes = ["KTUH", "TCC3", "TCD4", "TFB7"];
const gapStations = await db.from("stations").select("id,station_code,station_name,cluster,location_models(code)")
  .eq("company_id", COMPANY).in("station_code", gapCodes);
console.log("gap stations detail", gapStations.data);

// Recent NO_APPROVER across all Adhoc Van
const stuck = await db.from("payment_requests")
  .select("request_no,location_code,approval_status,adhoc_reason_key,current_approver_user_id,created_at,approval_routing_reason")
  .eq("company_id", COMPANY).eq("payment_head_id", head.id)
  .eq("approval_status", "NO_APPROVER_CONFIGURED")
  .order("created_at", { ascending: false }).limit(30);
console.log("stuck Adhoc Van NO_APPROVER", stuck.data);
