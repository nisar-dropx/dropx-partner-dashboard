import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const root = path.resolve(import.meta.dirname, "..");
const env = {
  ...loadEnv(path.join(root, ".env.vercel.prod.tmp")),
  ...loadEnv(path.join(root, ".env.local")),
  ...loadEnv(path.join(root, "../../Workforce-worker/.dev.vars")),
  ...loadEnv(path.join(root, "../../amazon-edd-worker/.dev.vars")),
};
const url =
  env.COMPANY_SUPABASE_URL ||
  env.NEXT_PUBLIC_SUPABASE_URL ||
  env.SUPABASE_URL;
const key =
  env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase URL or service role key.");
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await db
  .from("nl_dispute_requests")
  .select(
    "company_id,month,case_key,decision,status,source_stage,reason,version,submitted_at,updated_by_name,updated_by",
  )
  .eq("status", "submitted")
  .order("submitted_at", { ascending: true })
  .limit(300);

if (error) {
  console.error(error);
  process.exit(1);
}

const rows = data ?? [];
const byDecision = {};
const byMonth = {};
for (const r of rows) {
  byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
  byMonth[r.month] = (byMonth[r.month] || 0) + 1;
}
console.log(
  JSON.stringify(
    {
      pending: rows.length,
      byDecision,
      byMonth,
      sample: rows.slice(0, 40).map((r) => ({
        month: r.month,
        case_key: r.case_key,
        decision: r.decision,
        stage: r.source_stage,
        reason: r.reason,
        version: r.version,
        by: r.updated_by_name,
        at: r.submitted_at,
      })),
    },
    null,
    2,
  ),
);
