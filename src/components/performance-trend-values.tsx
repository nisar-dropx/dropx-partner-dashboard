import { formatTrendValue, type TrendPoint, type TrendSeries } from "@/lib/ops-pulse/review-trends";

// Ratios, percentages, times and cumulative MTD snapshots must never be summed.
const additiveMeasures = new Set(["delivered", "salary_da_cost", "ad_hoc_van", "ad_hoc_da", "day_cost"]);
export type TrendPeriod = 7 | 14 | "mtd";
export function trendPeriodPoints(points: TrendPoint[], period: TrendPeriod, endDate: string) {
  const throughDate = points.filter((point) => point.date <= endDate);
  return period === "mtd"
    ? throughDate.filter((point) => point.date.startsWith(endDate.slice(0, 7)))
    : throughDate.slice(-period);
}
export function recordedTrendTotal(series: TrendSeries, points: TrendPoint[]) {
  const recorded = points.filter((point) => point.value != null);
  return additiveMeasures.has(series.key) && recorded.length
    ? recorded.reduce((sum, point) => sum + point.value!, 0)
    : null;
}
function dayLabel(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));
}
export function PerformanceTrendValues({ series, period, endDate }: { series: TrendSeries; period: TrendPeriod; endDate: string }) {
  const points = trendPeriodPoints(series.points, period, endDate);
  const periodLabel = period === "mtd" ? "MTD" : `${period}-day`;
  const last = points.at(-1);
  const recorded = points.filter((point) => point.value != null);
  const total = recordedTrendTotal(series, points);
  return <>
    <div className="review-history-totals">
      <div><small>{last ? dayLabel(last.date) : "Selected day"}</small><strong>{formatTrendValue(last?.value ?? null, series.unit)}</strong></div>
      {total != null ? <div><small>{periodLabel} recorded total</small><strong>{formatTrendValue(total, series.unit)}</strong></div> : null}
    </div>
    <div className="review-history-caption"><span>Daily values · newest first</span><span>{recorded.length}/{points.length} days recorded</span></div>
    <div className="review-history-values" tabIndex={0} role="region" aria-label={`${periodLabel} daily values for ${series.label}`}>
      <table>
        <thead><tr><th>Date</th><th>{series.unit === "money" ? "Amount" : series.unit === "time" ? "Time" : "Value"}</th></tr></thead>
        <tbody>{[...points].reverse().map((point) => {
          const missed = point.value != null && series.target != null && (series.direction === "lower" ? point.value > series.target : point.value < series.target);
          return <tr key={point.date}>
            <td><time dateTime={point.date}>{dayLabel(point.date)}</time>{point.note && point.note !== "Hawkeye D-1" ? <small title={point.note}>{point.note}</small> : null}</td>
            <td className={missed ? "history-value-missed" : ""}><strong>{formatTrendValue(point.value, series.unit)}</strong>{missed ? <small>Off target</small> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </>;
}
