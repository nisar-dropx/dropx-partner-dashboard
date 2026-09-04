import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const component = read("src/components/performance-review-desk.tsx");
const opening = read("src/components/performance-opening-card.tsx");
const picker = read("src/components/performance-review-picker.tsx");
const styles = read("src/app/globals.css");
const reviewStyles = read("src/app/ops-pulse/performance/review-desk.css");

const checks = [
  [reviewStyles.includes(".performance-review-desk .performance-review-facts:has(> details[open]) { z-index: 20; }"), "open fact drill-downs stay above later station/EMD controls"],
  [reviewStyles.includes(".review-vehicles header { flex-wrap: wrap; }"), "vehicle header actions wrap instead of overlapping narrow layouts"],
  [styles.includes(".performance-review-facts { position: relative;"), "review facts provide one panel-bounded positioning context"],
  [styles.includes(".performance-associate-popover { right: auto; left: 0; width: min(760px, 100%); max-width: 100%; }"), "associate drill-down is contained by the performance panel"],
  [styles.includes(".performance-opening-popover { right: 0; left: auto; }"), "opening drill-down is aligned inside the performance panel"],
  [styles.includes(".performance-associate-popover-scroll { max-width: 100%; max-height: 290px; overflow: auto;"), "large associate lists scroll within their drill-down"],
  [styles.includes(".performance-associate-popover-head { position: sticky;"), "associate headers remain visible while scrolling"],
  [component.includes('className="performance-associate-popover-scroll"'), "associate table uses the contained scroll region"],
  [((component + opening).match(/name="performance-review-fact"/g) ?? []).length === 3, "top drill-downs form one exclusive accordion group"],
  [!styles.includes("details:nth-child(2) .performance-associate-popover"), "drill-down position does not depend on the selected card index"],
  [component.includes("<PerformanceReviewPicker"), "review desk uses the synchronized date and station picker"],
  [picker.includes('value={selectedDate}') && picker.includes('value={selectedStation}'), "picker controls remain synchronized with the loaded review"],
  [(picker.match(/onChange=/g) ?? []).length === 2 && picker.includes("router.push"), "date and station changes apply immediately"],
  [component.includes("Loaded performance date"), "loaded source date is explicit beside the picker"],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
for (const [passed, message] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${message}`);

if (failures.length) {
  console.error(`Performance review layout verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
