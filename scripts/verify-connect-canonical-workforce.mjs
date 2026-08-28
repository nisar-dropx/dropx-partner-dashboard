import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("apps/connect/src/lib/connect-auth.ts");
const connectTypes = read("apps/connect/src/lib/workforce-profiles.ts");
const dashboardTypes = read("src/lib/workforce-profiles.ts");
const migration = read("supabase/migrations/20260828233500_core_workforce_designation_cutover.sql");

const checks = [
  [connectTypes.includes('"workforce"'), "DropX One accepts the canonical Workforce profile type"],
  [dashboardTypes.includes('profileType === "workforce"') && dashboardTypes.includes('return "workforce" as const'), "Dashboard APIs resolve canonical Workforce accounts"],
  [auth.includes('["workforce", "field_executive", "contractor", "vendor", "worker"]'), "Account discovery reads Workforce before legacy registers"],
  [auth.includes("canonicalWorkforceSources"), "Legacy mirrored accounts are removed from the switcher"],
  [migration.includes("public.set_designation_register_route"), "Cutover uses the master-defined routing workflow"],
  [migration.includes("in ('DA', 'WM', 'ODCD', 'DCD')"), "All four requested designation codes are covered"],
  [migration.includes("raise exception 'One or more core Workforce designations"), "Partial cutovers fail atomically"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
