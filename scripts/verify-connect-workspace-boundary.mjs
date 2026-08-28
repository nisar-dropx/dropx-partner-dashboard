import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginFlow = readFileSync(resolve(root, "apps/connect/src/components/connect-login-flow.tsx"), "utf8");
const auth = readFileSync(resolve(root, "apps/connect/src/lib/connect-auth.ts"), "utf8");
const peopleDashboard = readFileSync(resolve(root, "apps/connect/src/components/connect-dashboard.tsx"), "utf8");
const workforceDashboard = readFileSync(resolve(root, "apps/connect/src/components/connect-workforce-workspace.tsx"), "utf8");

function requireSource(condition, message) {
  if (!condition) throw new Error(`DropX One workspace boundary failed: ${message}`);
}

const workforceStepsMatch = loginFlow.match(/const workforceSharedSteps = new Set<Step>\(\[([^\]]+)]\);/);
requireSource(workforceStepsMatch, "the Workforce route allow-list is missing");

const workforceSteps = Array.from(workforceStepsMatch[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
const expectedWorkforceSteps = ["accounts", "dashboard", "profile", "payments", "advances", "settings"];
requireSource(
  JSON.stringify(workforceSteps) === JSON.stringify(expectedWorkforceSteps),
  `Workforce routes changed (${workforceSteps.join(", ")})`
);

requireSource(
  loginFlow.includes("isWorkforceWorkspace(account) && !workforceSharedSteps.has(next)"),
  "the client route guard is missing"
);
requireSource(
  loginFlow.includes("<ConnectWorkforceWorkspace account={account}"),
  "the dedicated Workforce workspace is not rendered"
);
requireSource(
  !loginFlow.includes("variant={isWorkforceWorkspace(account)"),
  "the People dashboard is still being reused for Workforce"
);

const accessMatch = auth.match(/const workforceSharedPageAccess = \[([^\]]+)]/);
requireSource(accessMatch, "the server account access boundary is missing");
const accessPages = Array.from(accessMatch[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
requireSource(
  JSON.stringify(accessPages) === JSON.stringify(["dashboard", "profile", "advances", "settings"]),
  `Workforce server access changed (${accessPages.join(", ")})`
);

for (const peopleOnlyFeature of ["Attendance", "Roster", "Leave", "Performance", "Documents", "Reimbursements", "Approval Inbox"]) {
  requireSource(
    !workforceDashboard.includes(peopleOnlyFeature),
    `${peopleOnlyFeature} leaked into the Workforce workspace`
  );
}
requireSource(!peopleDashboard.includes("variant"), "the People dashboard still contains a Workforce variant");

console.log("DropX One workspace boundary verified: Workforce shares only Profile and Payments → Advances.");
