import { sumDot, type DotTotals } from "../ops-pulse/dot-metrics.ts";

export type EodDotRow = {
  Station: string;
  "Std eligible": number | string;
  "Std attempted": number | string;
  "Std delivered": number | string;
  "Std DOT %": string;
  "Prem eligible": number | string;
  "Prem attempted": number | string;
  "Prem delivered": number | string;
  "Prem DOT %": string;
  "All eligible": number | string;
  "All attempted": number | string;
  "All delivered": number | string;
  "All DOT %": string;
};

const unavailable = {
  eligible: "—",
  attempted: "—",
  delivered: "—",
  percentage: "—",
} as const;

function lane(totals?: DotTotals) {
  if (!totals) return unavailable;
  // `total` is the retained eligible cohort. It also includes metadata-pending
  // shipments, which must stay in the denominator rather than disappearing.
  const eligible = totals.total;
  // An attempt is a completed customer outcome. Parcels still at station,
  // on-road or metadata-pending are intentionally not counted as attempted.
  const attempted = totals.delivered + totals.failed + totals.rejected;
  return {
    eligible,
    attempted,
    delivered: totals.delivered,
    percentage: eligible ? `${(totals.delivered / eligible * 100).toFixed(1)}%` : "—",
  };
}

export function eodDotRow(station: string, standard?: DotTotals, premium?: DotTotals): EodDotRow {
  const standardLane = lane(standard);
  const premiumLane = lane(premium);
  const overallLane = lane(standard && premium ? sumDot([standard, premium]) : undefined);
  return {
    Station: station,
    "Std eligible": standardLane.eligible,
    "Std attempted": standardLane.attempted,
    "Std delivered": standardLane.delivered,
    "Std DOT %": standardLane.percentage,
    "Prem eligible": premiumLane.eligible,
    "Prem attempted": premiumLane.attempted,
    "Prem delivered": premiumLane.delivered,
    "Prem DOT %": premiumLane.percentage,
    "All eligible": overallLane.eligible,
    "All attempted": overallLane.attempted,
    "All delivered": overallLane.delivered,
    "All DOT %": overallLane.percentage,
  };
}

function totalLane(rows: EodDotRow[], eligibleKey: keyof EodDotRow, attemptedKey: keyof EodDotRow, deliveredKey: keyof EodDotRow) {
  const valid = rows.filter(row => typeof row[eligibleKey] === "number" && typeof row[attemptedKey] === "number" && typeof row[deliveredKey] === "number");
  if (!valid.length) return unavailable;
  const eligible = valid.reduce((sum, row) => sum + Number(row[eligibleKey]), 0);
  const attempted = valid.reduce((sum, row) => sum + Number(row[attemptedKey]), 0);
  const delivered = valid.reduce((sum, row) => sum + Number(row[deliveredKey]), 0);
  return { eligible, attempted, delivered, percentage: eligible ? `${(delivered / eligible * 100).toFixed(1)}%` : "—" };
}

export function eodDotTotalRow(rows: EodDotRow[]): EodDotRow {
  const standard = totalLane(rows, "Std eligible", "Std attempted", "Std delivered");
  const premium = totalLane(rows, "Prem eligible", "Prem attempted", "Prem delivered");
  const overall = totalLane(rows, "All eligible", "All attempted", "All delivered");
  return {
    Station: "Grand total",
    "Std eligible": standard.eligible,
    "Std attempted": standard.attempted,
    "Std delivered": standard.delivered,
    "Std DOT %": standard.percentage,
    "Prem eligible": premium.eligible,
    "Prem attempted": premium.attempted,
    "Prem delivered": premium.delivered,
    "Prem DOT %": premium.percentage,
    "All eligible": overall.eligible,
    "All attempted": overall.attempted,
    "All delivered": overall.delivered,
    "All DOT %": overall.percentage,
  };
}

export const EOD_DOT_VISIBLE_COLUMNS = [
  "Station",
  "Std eligible",
  "Std attempted",
  "Std delivered",
  "Std DOT %",
  "Prem eligible",
  "Prem attempted",
  "Prem delivered",
  "Prem DOT %",
  "All eligible",
  "All attempted",
  "All delivered",
  "All DOT %",
] as const;

export const EOD_DOT_PERCENTAGE_COLUMNS = ["Std DOT %", "Prem DOT %", "All DOT %"] as const;
