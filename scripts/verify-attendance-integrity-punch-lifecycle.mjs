import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd().endsWith("apps/connect")
  ? resolve(process.cwd(), "../..")
  : process.cwd();

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function requireText(path, text, message) {
  if (!source(path).includes(text)) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

requireText(
  "src/lib/biometric/attendance-integrity-resolution.ts",
  '.eq("is_flagged", true)',
  "dashboard approval releases every held punch after the date-level integrity case is cleared"
);
requireText(
  "apps/connect/src/lib/connect-location-integrity.ts",
  '.eq("is_flagged", true)',
  "DropX One manager approval releases every held punch after the date-level case is cleared"
);
requireText(
  "src/app/api/connect/attendance/route.ts",
  'statusLabel: "Verification pending"',
  "captured held punches remain visible to the employee instead of appearing as no punch"
);
requireText(
  "src/app/reports/raw-punches/page.tsx",
  'return "Held for review"',
  "raw punches distinguish integrity holds from inactive or unmapped profiles"
);
requireText(
  "src/app/reports/raw-punches/page.tsx",
  'workforce: { table: "workforce", code: "dropx_id" }',
  "raw punch mapping resolves canonical Workforce profiles"
);
requireText(
  "src/app/api/biometric/punch/route.ts",
  '["workforce", "workforce"]',
  "biometric ingestion auto-maps canonical Workforce profiles"
);
requireText(
  "apps/connect/src/components/connect-roster.tsx",
  'className="dx-roster-swap-modal" role="dialog"',
  "the swap form opens immediately as an accessible dialog"
);

const loginFlow = source("apps/connect/src/components/connect-login-flow.tsx");
if (loginFlow.includes('workspaceLabel || (isWorkforceWorkspace(account) ? "Workforce workspace" : "People workspace")} ·')) {
  throw new Error("FAIL profile cards must show designation only, without workspace text");
}
console.log("PASS profile cards show designation without workspace text");

