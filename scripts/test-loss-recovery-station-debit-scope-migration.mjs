// Run from the repo root: node scripts/test-loss-recovery-station-debit-scope-migration.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(
  join(root, "supabase/migrations/20261028120000_loss_recovery_station_debit_scope.sql"),
  "utf8",
);
const db = new PGlite();

await db.exec(`
create table nl_loss_sources (
  company_id uuid primary key,
  recovery_policy jsonb not null
);
insert into nl_loss_sources values (
  '00000000-0000-0000-0000-000000000001',
  '{
    "directory_ceiling_designations":["AOM"],
    "directory_excluded_designations":["NH","BH","OWNER"],
    "eligible_designations":["Cluster Manager","Station Manager","Delivery Associate","City Manager","Area Operations Manager","Team Lead"]
  }'::jsonb
);
`);

await db.exec(sql);
await db.exec(sql); // idempotent

const row = (
  await db.query(`select recovery_policy from nl_loss_sources`)
).rows[0].recovery_policy;

const ceiling = row.directory_ceiling_designations;
const excluded = new Set(row.directory_excluded_designations);
const eligible = new Set(row.eligible_designations.map((n) => n.toLowerCase()));

function eq(label, a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error("FAIL", label, a, b);
    process.exit(1);
  }
  console.log("ok", label);
}

eq("ceiling", ceiling, ["STM"]);
eq("excludes CLM", excluded.has("CLM"), true);
eq("excludes CM", excluded.has("CM"), true);
eq("excludes AOM", excluded.has("AOM"), true);
eq("keeps prior NH", excluded.has("NH"), true);
eq("eligible drops cluster", eligible.has("cluster manager"), false);
eq("eligible drops city", eligible.has("city manager"), false);
eq("eligible drops aom", eligible.has("area operations manager"), false);
eq("eligible keeps stm", eligible.has("station manager"), true);
eq("eligible keeps da", eligible.has("delivery associate"), true);
eq("eligible keeps tl", eligible.has("team lead"), true);
console.log("loss recovery station debit scope migration ok");
