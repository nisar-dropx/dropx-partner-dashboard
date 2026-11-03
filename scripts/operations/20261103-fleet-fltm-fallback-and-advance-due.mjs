/**
 * 1) Company-breakdown Adhoc Van step 1: FLEET_FLTM → OPERATIONS_FLTM → FLEET_BH
 *    so a newly hired Fleet Manager maps automatically; Inayath remains fallback.
 * 2) pay_advance_due: scheduled installment for this month only; unpaid prior
 *    months do not pile into later live/payroll months unless recovery already
 *    started (used > 0), so partial remainder can still finish.
 *
 * APPLY=1 writes. Default dry-run.
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

const env = loadEnv();
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "https://uimajyffojydenqsegjv.supabase.co",
  env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const APPLY = process.env.APPLY === "1";
const FLEET_FLTM = "e1dc5c0a-3a60-4000-9f00-1c0a1cf97cc7";
const OPERATIONS_FLTM = "546becfb-3128-4bbb-bbf3-048548b49c8d";
const FLEET_BH = "9a972cc2-1b72-4624-a554-b52565bc5568";
const INAYATH = "2b2310ce-ffef-4b6c-8386-00a77dd724b7";

const step1Candidates = [
  { role_id: FLEET_FLTM, scope: "company" },
  { role_id: OPERATIONS_FLTM, scope: "company" },
  { role_id: FLEET_BH, scope: "company" },
];

const { data: rules, error: rulesError } = await db.from("fleet_adhoc_reason_rules")
  .select("reason_key,approval_steps")
  .eq("company_id", COMPANY)
  .in("reason_key", ["company_breakdown", "breakdown_vehicle"]);
if (rulesError) throw new Error(rulesError.message);

console.log("Current breakdown step1", rules.map((r) => ({
  key: r.reason_key,
  roles: (r.approval_steps?.[0]?.candidates || []).map((c) => c.role_id),
})));
console.log("Proposed step1 order: FLEET_FLTM → OPERATIONS_FLTM → FLEET_BH");

if (!APPLY) {
  console.log("\nDry-run only. Re-run with APPLY=1 to update rules + pay_advance_due.");
  process.exit(0);
}

for (const rule of rules) {
  const steps = structuredClone(rule.approval_steps || []);
  const step1 = steps.find((s) => s.step_order === 1) || steps[0];
  if (!step1) continue;
  step1.candidates = step1Candidates;
  const { error } = await db.from("fleet_adhoc_reason_rules").update({ approval_steps: steps })
    .eq("company_id", COMPANY).eq("reason_key", rule.reason_key);
  if (error) throw new Error(error.message);
  console.log("Updated rule", rule.reason_key);
}

// Keep open remapped requests on Inayath (FLEET_BH) but refresh frozen step candidates.
const { data: head } = await db.from("payment_heads").select("id").eq("company_id", COMPANY).eq("code", "VAN_ADHOC").maybeSingle();
const { data: stuck } = await db.from("payment_requests")
  .select("id,request_no,adhoc_approval_steps,current_approver_user_id")
  .eq("company_id", COMPANY).eq("payment_head_id", head.id)
  .in("adhoc_reason_key", ["company_breakdown", "breakdown_vehicle"])
  .in("approval_status", ["PENDING", "NO_APPROVER_CONFIGURED"]);
for (const req of stuck || []) {
  const steps = structuredClone(req.adhoc_approval_steps || []);
  const step1 = steps.find((s) => s.step_order === 1) || steps[0];
  if (step1) step1.candidates = step1Candidates;
  const { error } = await db.from("payment_requests").update({
    adhoc_approval_steps: steps.length ? steps : req.adhoc_approval_steps,
    approval_status: "PENDING",
    current_approver_user_id: req.current_approver_user_id || INAYATH,
    current_approver_role_id: FLEET_BH,
    current_approver_role_ids: [FLEET_BH],
    approval_routing_reason: "Fleet breakdown step: FLEET_FLTM → OPERATIONS_FLTM → FLEET_BH (Inayath fallback until new Fleet Manager is active)",
    updated_at: new Date().toISOString(),
  }).eq("company_id", COMPANY).eq("id", req.id);
  if (error) throw new Error(error.message);
  console.log("Refreshed request", req.request_no);
}

const migration = resolve(process.cwd(), "supabase/migrations/20261103143000_advance_due_month_window.sql");
const { spawnSync } = await import("node:child_process");
const result = spawnSync("npx", ["supabase", "db", "query", "-f", migration, "--linked"], {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: true,
});
console.log(result.stdout || "");
if (result.status !== 0) {
  console.error(result.stderr || result.error);
  console.log("Apply migration manually:", migration);
  process.exit(result.status || 1);
}
console.log("Updated pay_advance_due from", migration);

const worker = (await db.from("workforce").select("id").eq("company_id", COMPANY).eq("dropx_id", "DROPX5026").maybeSingle()).data;
for (const month of ["2026-10-01", "2026-11-01"]) {
  const due = await db.rpc("pay_advance_due", {
    p_company: COMPANY,
    p_worker_type: "workforce",
    p_worker: worker.id,
    p_period: month,
    p_target_kind: "workforce",
    p_target_key: `${worker.id}:${month}`,
  });
  console.log(month, due.error?.message || due.data);
}
