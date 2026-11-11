import { sumDot, type DotTotals } from "../ops-pulse/dot-metrics.ts";

export type EodDotRow = {
  Station: string;
  "Standard eligible": number | string;
  "Standard delivered": number | string;
  "Standard DOT %": string;
  "Premium eligible": number | string;
  "Premium delivered": number | string;
  "Premium DOT %": string;
  "Overall eligible": number | string;
  "Overall delivered": number | string;
  "Overall DOT %": string;
};

const unavailable = {
  eligible: "—",
  delivered: "—",
  percentage: "—",
} as const;

function lane(totals?: DotTotals) {
  if (!totals) return unavailable;
  // `total` is the retained eligible cohort. It also includes metadata-pending
  // shipments, which must stay in the denominator rather than disappearing.
  const eligible = totals.total;
  return {
    eligible,
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
    "Standard eligible": standardLane.eligible,
    "Standard delivered": standardLane.delivered,
    "Standard DOT %": standardLane.percentage,
    "Premium eligible": premiumLane.eligible,
    "Premium delivered": premiumLane.delivered,
    "Premium DOT %": premiumLane.percentage,
    "Overall eligible": overallLane.eligible,
    "Overall delivered": overallLane.delivered,
    "Overall DOT %": overallLane.percentage,
  };
}

function totalLane(rows: EodDotRow[], eligibleKey: keyof EodDotRow, deliveredKey: keyof EodDotRow) {
  const valid = rows.filter(row => typeof row[eligibleKey] === "number" && typeof row[deliveredKey] === "number");
  if (!valid.length) return unavailable;
  const eligible = valid.reduce((sum, row) => sum + Number(row[eligibleKey]), 0);
  const delivered = valid.reduce((sum, row) => sum + Number(row[deliveredKey]), 0);
  return { eligible, delivered, percentage: eligible ? `${(delivered / eligible * 100).toFixed(1)}%` : "—" };
}

export function eodDotTotalRow(rows: EodDotRow[]): EodDotRow {
  const standard = totalLane(rows, "Standard eligible", "Standard delivered");
  const premium = totalLane(rows, "Premium eligible", "Premium delivered");
  const overall = totalLane(rows, "Overall eligible", "Overall delivered");
  return {
    Station: "Grand total",
    "Standard eligible": standard.eligible,
    "Standard delivered": standard.delivered,
    "Standard DOT %": standard.percentage,
    "Premium eligible": premium.eligible,
    "Premium delivered": premium.delivered,
    "Premium DOT %": premium.percentage,
    "Overall eligible": overall.eligible,
    "Overall delivered": overall.delivered,
    "Overall DOT %": overall.percentage,
  };
}

export const EOD_DOT_VISIBLE_COLUMNS = [
  "Station",
  "Standard eligible",
  "Standard DOT %",
  "Premium eligible",
  "Premium DOT %",
  "Overall eligible",
  "Overall DOT %",
] as const;

export const EOD_DOT_PERCENTAGE_COLUMNS = ["Standard DOT %", "Premium DOT %", "Overall DOT %"] as const;
