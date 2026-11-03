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

const { data: reqs } = await db.from("payment_requests")
  .select("request_no,approval_status,current_approver_user_id,current_approver_role_id,adhoc_approval_steps,approval_routing_reason")
  .eq("company_id", COMPANY).in("request_no", ["EDK57NMTFH", "42JAESVZ4I"]);
const { data: profiles } = await db.from("profiles").select("id,full_name").in("id", [...new Set((reqs || []).map((r) => r.current_approver_user_id).filter(Boolean))]);
const name = Object.fromEntries((profiles || []).map((p) => [p.id, p.full_name]));
const { data: roles } = await db.from("user_roles").select("id,code").eq("company_id", COMPANY);
const role = Object.fromEntries((roles || []).map((r) => [r.id, r.code]));
console.log((reqs || []).map((r) => ({
  request_no: r.request_no,
  status: r.approval_status,
  approver: name[r.current_approver_user_id],
  role: role[r.current_approver_role_id],
  step1: r.adhoc_approval_steps?.[0]?.candidates?.map((c) => role[c.role_id]),
  reason: r.approval_routing_reason,
})));

const { data: rules } = await db.from("fleet_adhoc_reason_rules").select("reason_key,approval_steps")
  .eq("company_id", COMPANY).in("reason_key", ["company_breakdown", "breakdown_vehicle"]);
console.log("rules step1", (rules || []).map((r) => ({
  key: r.reason_key,
  step1: r.approval_steps?.[0]?.candidates?.map((c) => role[c.role_id]),
})));
