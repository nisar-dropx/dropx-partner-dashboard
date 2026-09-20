import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const loader = read("src/lib/people-operational-hierarchy.ts");
const cod = read("src/lib/ops-pulse/cod.ts");
const switcher = read("src/components/ops-context-switcher.tsx");
const routing = read("src/lib/approval-workflow-routing.ts");
const reviews = read("src/lib/ops-pulse/performance-review.ts");
const locationMaster = read("src/app/master/location/page.tsx");

const checks = [
  [loader.includes('from("hr_work_assignments")') && loader.includes('from("hr_reporting_relationships")'), "operational hierarchy loads People assignments and solid-line reporting relationships"],
  [cod.includes("loadPeopleOperationalHierarchy") && cod.includes('hierarchy_source: "people"'), "shared OpsPulse locations are overlaid from People"],
  [switcher.includes("reporting_authorities") && switcher.includes("cluster_manager_names"), "global scope filter presents People reporting authorities and cluster managers"],
  [routing.includes("loadPeopleOperationalHierarchy") && !routing.includes('.select("id,region,cluster")'), "approval same-cluster routing uses People rather than station text"],
  [reviews.includes("primaryReportingChain") && !reviews.includes('from("org_positions")') && !reviews.includes("reports_to_user_id"), "performance reviews use the People reporting chain"],
  [locationMaster.includes("loadPeopleOperationalHierarchy"), "location master presents the People hierarchy"],
  [![cod, switcher, routing, reviews, locationMaster].some((source) => /Dhananjay/i.test(source)), "supported hierarchy surfaces contain no hard-coded legacy manager"],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
for (const [passed, message] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${message}`);

if (failures.length) {
  console.error(`People operational hierarchy verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

