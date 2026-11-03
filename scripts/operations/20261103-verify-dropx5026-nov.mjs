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
const { data: worker } = await db.from("workforce").select("id").eq("company_id", COMPANY).eq("dropx_id", "DROPX5026").maybeSingle();
for (const month of ["2026-10-01", "2026-11-01"]) {
  const due = await db.rpc("pay_advance_due", {
    p_company: COMPANY,
    p_worker_type: "workforce",
    p_worker: worker.id,
    p_period: month,
    p_target_kind: "workforce",
    p_target_key: `${worker.id}:${month}`,
  });
  console.log(month, due.data);
}
const { data: roles } = await db.from("user_roles").select("id,code").eq("company_id", COMPANY);
const role = Object.fromEntries((roles || []).map((r) => [r.id, r.code]));
const { data: rules } = await db.from("fleet_adhoc_reason_rules").select("reason_key,approval_steps")
  .eq("company_id", COMPANY).in("reason_key", ["company_breakdown", "breakdown_vehicle"]);
console.log("rules", rules.map((r) => ({
  key: r.reason_key,
  step1: (r.approval_steps?.[0]?.candidates || []).map((c) => role[c.role_id]),
})));
