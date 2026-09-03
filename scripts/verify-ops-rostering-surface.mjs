import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const middleware = read("src/middleware.ts");
const peopleSurface = read("src/lib/people/surface.ts");
const accessSurface = read("src/lib/access-surface.ts");
const navigation = read("src/lib/ops-pulse/navigation.ts");
const page = read("src/app/ops-pulse/rostering/page.tsx");
const actions = read("src/app/ops-pulse/rostering/actions.ts");
const rosterLibrary = read("src/lib/ops-pulse/rostering.ts");
const planner = read("src/components/ops-roster-planner.tsx");
const permissions = read("scripts/ops_pulse_rostering_v1.sql");

const cleanOpsRoots = middleware.match(/CLEAN_OPS_ROOTS[^;]+/)?.[0] ?? "";
const checks = [
  [cleanOpsRoots.includes('"/rostering"'), "The OpsPulse host must allow the clean /rostering route."],
  [peopleSurface.includes('"/rostering"'), "The existing People rostering route must remain available on the People host."],
  [accessSurface.includes('"ops_rostering"'), "Rostering must belong to the OpsPulse permission surface."],
  [navigation.includes('{ code: "ops_rostering", label: "Rostering", href: "/rostering"'), "OpsPulse navigation must expose the Rostering menu."],
  [page.includes('requirePagePermission("ops_rostering", "access")'), "The roster workspace must enforce its dedicated page permission."],
  [actions.includes('from("hr_roster_plans")') && actions.includes('from("hr_roster_entries")'), "OpsPulse must update the canonical People roster, not a duplicate dataset."],
  [actions.includes("const start = rosterMonday(indiaToday())"), "OpsPulse roster corrections must start in the current week, matching People."],
  [actions.includes("rosterSubmissionWindowError") && rosterLibrary.includes("effectiveFrom > currentWeekMonday") && rosterLibrary.includes("minimumFutureRosterMonday"), "Current-week roster corrections must follow the canonical People deadline rule."],
  [["OPERATIONS_TL", "OPERATIONS_STM", "OPERATIONS_CLM", "OPERATIONS_AOM", "OPERATIONS_RM", "OPERATIONS_NH"].every((code) => permissions.includes(`'${code}'`)), "Roster defaults must cover the canonical Ops planning and approval roles."],
  [!["Bulk upload", "Version history", "Change logs"].some((label) => `${page}\n${planner}`.includes(label)), "The compact OpsPulse roster must not expose People administration tools."],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(`OpsPulse Rostering verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("OpsPulse Rostering surface and canonical data boundary verified.");
