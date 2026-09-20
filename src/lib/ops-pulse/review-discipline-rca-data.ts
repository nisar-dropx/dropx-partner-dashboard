import "server-only";
import type { CodLocationRow } from "./cod";
import { loadPerformanceOperationalSnapshots } from "./performance-review";
import { loadReviewUtrDiscipline } from "./review-operations-data";
import { buildDisciplineRca } from "./review-discipline-rca";

/** Only called after the server action has checked company, station and review scope. */
export async function loadDisciplineRca(companyId: string, station: CodLocationRow, date: string) {
  const [opening, utr] = await Promise.all([
    loadPerformanceOperationalSnapshots(companyId, date, [station]),
    loadReviewUtrDiscipline(companyId, station, date)
  ]);
  const snapshot = opening.rows.get(station.station_code);
  if (opening.error || utr.error || !snapshot) throw Error("Unable to verify opening / UTR delays. Refresh and try again.");
  return buildDisciplineRca(snapshot, utr.discipline);
}
