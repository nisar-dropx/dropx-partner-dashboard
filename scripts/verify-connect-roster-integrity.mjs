import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const route = read("apps/connect/app/api/connect/roster/route.ts");
const component = read("apps/connect/src/components/connect-roster.tsx");

const checks = [
  [route.includes('.eq("hr_roster_plans.status", "approved")') && route.includes('.eq("hr_roster_plans.roster_kind", "recurring_weekly")'), "recurring projection reads only approved weekly plans"],
  [route.includes('.eq("location_id", locationId)') && route.includes("resolveWorkerIdentities") && route.includes("isOwnIdentity"), "recurring projection remains scoped to the signed-in People identity and location across category history"],
  [route.includes("requester_shift_id,partner_shift_id,requester_day_type,partner_day_type"), "swap history loads immutable shift and day snapshots"],
  [route.includes("storedShiftIds") && route.includes('db().from("hr_shifts")'), "historical swaps resolve their stored shifts after a roster revision"],
  [route.includes("projectedEntryId") && route.includes("hr_create_roster_swap_request"), "recurring dates materialize safe one-day swap overrides"],
  [route.includes("expandRecurringColleagueEntries") && component.includes("requesterEntryId: selectedDay.id") && component.includes("rosterDate: selectedDay.date"), "projected dates load colleagues and submit their exact roster date"],
  [component.includes('day.canSwap && day.partners.length') && component.includes("Request swap") && !component.includes('day.isProjected ? "Recurring schedule"'), "eligible recurring dates expose the swap action"],
  [route.includes("isMeaningfulRosterSwap(entry, candidate)") && route.includes("Choose a colleague whose roster is different for this date."), "no-op weekly-off and same-shift swaps are hidden and rejected"],
  [route.includes("stationSameDesignationFlags") && route.includes("sameStationDesignation") && route.includes("resolveWorkerDesignationIds") && route.includes("Choose a colleague with the same designation.") && route.includes("isHeadOfficeLocation"), "station swaps restrict partners to the same designation while HO keeps cross-designation partners"],
  [route.includes("assertSwapBeforeCutoff(requester, partner") && route.includes("assertWeekOffSwapBeforeCutoff") && route.includes("involvesWeekOff"), "week-off swaps use day-end cutoff while working swaps keep shift cutoff"],
  [route.includes("sameRosterLocation") && route.includes("fallbackLocationId") && route.includes("rosterDate > todayIndia()"), "week-off swaps keep future dates open and match colleagues when location is missing"],
  [component.includes('"No valid swap"') && component.includes("Only different rosters can be exchanged."), "unavailable swap days explain the eligibility rule"],
  [component.includes("Swap off") && component.includes("dx-roster-day-hit") && component.includes("openSwap(day)"), "week-off days expose a clear swap action"],
  [component.includes("activeRequests") && component.includes("completedRequests") && component.includes("dx-roster-panel") && component.includes("dx-roster-summary"), "active requests, history, and the mobile day list stay separated"],
  [component.includes("Recent swap history") && component.includes("You requested with"), "swap history is compact and shows request direction"],
  [component.includes("Your roster is not configured") && component.includes("Contact your HR or manager."), "an actually empty roster gives one clear next step"]
];

const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
if (failed.length) process.exit(1);
