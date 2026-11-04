/**
 * Spot-check: unpaid loss lines scheduled for an earlier open month must not
 * also appear in a later month's nl_loss_recovery_due result.
 * Dry-read only.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const out = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      for (const line of readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/)) {
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
  env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.COMPANY_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";

const { data: oct, error: octErr } = await db.rpc("nl_loss_recovery_due", {
  p_company: COMPANY,
  p_salary_month: "2026-10",
  p_target: "workforce",
});
if (octErr) throw new Error(octErr.message);
const { data: nov, error: novErr } = await db.rpc("nl_loss_recovery_due", {
  p_company: COMPANY,
  p_salary_month: "2026-11",
  p_target: "workforce",
});
if (novErr) throw new Error(novErr.message);

const octKeys = new Set((oct || []).map((r) => r.recovery_key));
const novOverlap = (nov || []).filter((r) => octKeys.has(r.recovery_key) && String(r.deduction_month || "").slice(0, 7) === "2026-10");

console.log("Oct due lines", (oct || []).length);
console.log("Nov due lines", (nov || []).length);
console.log("Oct-scheduled keys still due in Nov", novOverlap.length);
if (novOverlap.length) {
  console.log(novOverlap.slice(0, 10).map((r) => ({
    key: r.recovery_key,
    amount: r.amount,
    worker: r.employee_code || r.worker_id,
    deduction_month: r.deduction_month,
  })));
}

const sample = (oct || []).find((r) => String(r.deduction_month || "").slice(0, 7) === "2026-10");
if (sample) {
  const { data: open } = await db.rpc("loss_recovery_open_payroll", {
    p_company: COMPANY,
    p_ref: `workforce:${sample.worker_id}`,
    p_month: "2026-10",
  });
  console.log("Sample Oct line", {
    key: sample.recovery_key,
    amount: sample.amount,
    code: sample.employee_code,
    octStillOpen: open,
    stillInNov: novOverlap.some((r) => r.recovery_key === sample.recovery_key),
  });
}
