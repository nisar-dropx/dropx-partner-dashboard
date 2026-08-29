import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginFlow = readFileSync(resolve(root, "apps/connect/src/components/connect-login-flow.tsx"), "utf8");
const auth = readFileSync(resolve(root, "apps/connect/src/lib/connect-auth.ts"), "utf8");
const peopleDashboard = readFileSync(resolve(root, "apps/connect/src/components/connect-dashboard.tsx"), "utf8");

function requireSource(condition, message) {
  if (!condition) throw new Error(`DropX One workspace boundary failed: ${message}`);
}

requireSource(
  loginFlow.includes("<ConnectPeopleWorkspace account={account}"),
  "the People manager workspace is not rendered"
);
requireSource(
  loginFlow.includes('variant={isWorkforceWorkspace(account) ? "workforce" : "people"}'),
  "the shared dashboard is not using the Workforce variant"
);
requireSource(
  !loginFlow.includes("<ConnectWorkforceWorkspace account={account}"),
  "the stripped-down Workforce workspace replaced the shared dashboard"
);
requireSource(
  loginFlow.includes("showLopNav") && loginFlow.includes('<ConnectLeave account={account} lopOnly />'),
  "contractor LOP navigation is missing"
);
requireSource(
  !loginFlow.includes("workforceSharedSteps"),
  "the Workforce route allow-list is still blocking attendance and roster"
);
requireSource(
  !auth.includes("workforceSharedPageAccess"),
  "Workforce page access is still being stripped on the server"
);
requireSource(
  auth.includes("intersectPageAccess(categoryPages, designationPages)"),
  "Workforce page access must follow category and designation rules"
);
requireSource(
  auth.includes("loadPeopleOnlyDesignationKeys") && auth.includes("matchesPeopleOnlyDesignation"),
  "People-only designation routing must collapse duplicate Workforce mirrors"
);
requireSource(
  peopleDashboard.includes('variant?: "people" | "workforce"'),
  "the shared dashboard variant prop is missing"
);

console.log("DropX One workspace boundary verified: managers use People workspace; workforce uses the shared dashboard with full category access.");
