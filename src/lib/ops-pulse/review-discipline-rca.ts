import type { PerformanceOperationalSnapshot, PerformanceReviewItem } from "./performance-review";
import { reviewClock, type UtrDiscipline } from "./review-operations";

export const DISCIPLINE_REASON_MAX = 240;
export const isDisciplineRcaKey = (key: string) => key === "station_opening_late" || /^utr_late_(employee|contractor)_[a-zA-Z0-9-]+$/.test(key);

export type DisciplineRca = {
  key: string; label: string; short: string; actual: number; target: number;
  direction: "lower"; severity: "red"; reasonOnly: true; evidence: string;
};
type Opening = Pick<PerformanceOperationalSnapshot, "firstPunchAt" | "firstPunchBy" | "scheduledOpeningTime" | "openingLateMinutes">;

/** The same source decisions as the two review cards; unknown/off-duty is not late. */
export function buildDisciplineRca(opening: Opening, utr: UtrDiscipline): DisciplineRca[] {
  const rows: DisciplineRca[] = [];
  if (opening.firstPunchAt && opening.scheduledOpeningTime && (opening.openingLateMinutes ?? 0) > 0) {
    rows.push({ key: "station_opening_late", label: "Station opening · Late", short: "Late station opening",
      actual: opening.openingLateMinutes!, target: 0, direction: "lower", severity: "red", reasonOnly: true,
      evidence: `Expected ${opening.scheduledOpeningTime.slice(0, 5)} · Opened ${reviewClock(opening.firstPunchAt)} · ${opening.openingLateMinutes} min late${opening.firstPunchBy ? ` · ${opening.firstPunchBy}` : ""}` });
  }
  for (const person of utr.rows) {
    if (person.lateMinutes <= 0 || person.status !== `${person.lateMinutes} min late`) continue;
    const key = `utr_late_${person.id.replace(":", "_")}`;
    if (!isDisciplineRcaKey(key)) continue;
    rows.push({ key, label: `UTR late · ${person.name}`.slice(0, 250), short: `UTR late · ${person.name}`,
      actual: person.lateMinutes, target: 0, direction: "lower", severity: "red", reasonOnly: true,
      evidence: `${person.role} · ${person.code} · Shift ${person.shift || "linked"} · Reported ${reviewClock(person.inTime)} · ${person.lateMinutes} min late` });
  }
  return rows;
}

export function disciplineReason(value: string) {
  const reason = value.replace(/\s+/g, " ").trim();
  if (!reason) throw Error("Add a short reason for the delay.");
  if (reason.length > DISCIPLINE_REASON_MAX) throw Error(`Keep the reason within ${DISCIPLINE_REASON_MAX} characters.`);
  return reason;
}

export function missingDisciplineReasons(rows: Pick<DisciplineRca, "key" | "label">[], items: Pick<PerformanceReviewItem, "metric_key" | "root_cause">[]) {
  const saved = new Map(items.map(item => [item.metric_key, item.root_cause]));
  return rows.filter(row => !saved.get(row.key)?.trim());
}
