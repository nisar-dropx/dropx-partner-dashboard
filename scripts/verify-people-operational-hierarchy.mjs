import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const loader = read("src/lib/people-operational-hierarchy.ts");
const cod = read("src/lib/ops-pulse/cod.ts");
const switcher = read("src/components/ops-context-switcher.tsx");
const routing = read("src/lib/approval-workflow-routing.ts");
const reviews = read("src/lib/ops-pulse/performance-review.ts");
const locationMaster = read("src/app/master/location/page.tsx");
const scopeSync = read("supabase/migrations/20261024170000_sync_people_station_routing.sql");

const checks = [
  [loader.includes('from("hr_work_assignments")') && loader.includes('from("hr_reporting_relationships")'), "operational hierarchy loads People assignments and solid-line reporting relationships"],
  [cod.includes("loadPeopleOperationalHierarchy") && cod.includes('hierarchy_source: "people"'), "shared OpsPulse locations are overlaid from People"],
  [switcher.includes("reporting_authorities") && switcher.includes("cluster_manager_names"), "global scope filter presents People reporting authorities and cluster managers"],
  [routing.includes("loadPeopleOperationalHierarchy") && !routing.includes('.select("id,region,cluster")'), "approval same-cluster routing uses People rather than station text"],
  [reviews.includes("loadPeopleReviewRoute") && !reviews.includes('from("org_positions")') && !reviews.includes("reports_to_user_id"), "performance reviews use the People reporting chain"],
  [locationMaster.includes("loadPeopleOperationalHierarchy"), "location master presents the People hierarchy"],
  [loader.includes("options.includeStationResponsibilities !== false"), "current hierarchy views include People station responsibilities by default"],
  [scopeSync.includes("reconcile_people_operational_routing") && scopeSync.includes("trg_sync_people_operational_routing_from_scope"), "People managed-location changes reconcile station ownership and reporting chains"],
  [scopeSync.includes("trg_delete_membership_scopes_from_person") && scopeSync.includes("trg_delete_people_operational_routing_from_scope"), "People scope removal revokes generated portal access and stale operational routing"],
  [scopeSync.includes("company_product_memberships") && scopeSync.includes("'designation_policy', 'google_workspace', 'person_override'"), "People-generated Finance, OpsPulse, Recruit and Workforce memberships inherit People station scope"],
  [scopeSync.includes("reconcile_legacy_profile_reporting_manager") && scopeSync.includes("reports_to_user_id = v_manager_user_id"), "legacy Recruit and notification reporting mirrors the current People reporting chain"],
  [["from_engagement", "from_assignment", "from_identity_link", "from_profile", "from_designation"].every((suffix) => scopeSync.includes(`trg_sync_people_operational_routing_${suffix}`)), "routing automatically reacts to offboarding, assignment, identity, profile and designation changes"],
  [scopeSync.includes("source_system in ('designation_policy', 'google_workspace', 'person_override')") && !scopeSync.includes("source_system not in ('manual'"), "manual and portal-owned access exceptions are not overwritten by People synchronization"],
  [![cod, switcher, routing, reviews, locationMaster].some((source) => /Dhananjay/i.test(source)), "supported hierarchy surfaces contain no hard-coded legacy manager"],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
for (const [passed, message] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${message}`);

if (failures.length) {
  console.error(`People operational hierarchy verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

