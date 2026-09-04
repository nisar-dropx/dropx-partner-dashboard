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
const count = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
export const isAdHocVanSeries = (series: TrendSeries) => series.key.startsWith("ad_hoc_van");
export function trendPointDetail(series: TrendSeries, point: TrendPoint) {
  if (!isAdHocVanSeries(series) || !point.context) return point.note || "—";
  const vans = point.context.vanCount ?? 0,
    delivered = point.context.delivered,
    shipments = point.context.adHocVanShipments;
  return [
    `${count(vans)} van${vans === 1 ? "" : "s"}`,
    delivered == null ? "Delivered volume unavailable" : `${count(delivered)} total delivered`,
    shipments == null ? "Van shipment volume not recorded" : `${count(shipments)} van shipments`,
  ].join(" · ");
}
function vanPeriodSummary(points: TrendPoint[]) {
  const context = points.flatMap((point) => point.context ? [point.context] : []),
    vans = context.reduce((sum, row) => sum + (row.vanCount ?? 0), 0),
    deliveredRows = context.flatMap((row) => row.delivered == null ? [] : [row.delivered]),
    shipmentRows = context.flatMap((row) => row.adHocVanShipments == null ? [] : [row.adHocVanShipments]);
  return {
    vans,
    delivered: deliveredRows.length === context.length && context.length
      ? deliveredRows.reduce((sum, value) => sum + value, 0)
      : null,
    shipments: shipmentRows.length === context.length && context.length
      ? shipmentRows.reduce((sum, value) => sum + value, 0)
      : null,
  };
}
export function TrendPointRequestDetails({ series, point }: { series: TrendSeries; point: TrendPoint | undefined }) {
  if (!point || !isAdHocVanSeries(series)) return null;
  const requests = point.context?.requests ?? [];
  return <section className="review-van-request-details" aria-label={`Ad-hoc van details for ${dayLabel(point.date)}`}>
    <header>
      <div><strong>{dayLabel(point.date)} · van details</strong><small>{trendPointDetail(series, point)}</small></div>
      <b>{formatTrendValue(point.value, series.unit)}</b>
    </header>
    {requests.length ? <div className="review-van-request-list">{requests.map((request, index) => {
      const remarks = request.remarks?.trim(),
        fields = (request.fields ?? []).filter((field) => {
          const normalized = field.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
          return !/(REASON|REMARK)/.test(normalized) || ![request.reason, remarks].includes(field.value);
        });
      return <article key={`${request.requestNo}-${index}`}>
        <div><strong>{request.requestNo}</strong><b>{formatTrendValue(request.amount, "money")}</b></div>
        <dl>
          <div><dt>Reason</dt><dd>{request.reason}</dd></div>
          {remarks && remarks !== request.reason ? <div><dt>Remarks</dt><dd>{remarks}</dd></div> : null}
          {fields.map((field, fieldIndex) => <div key={`${field.label}-${fieldIndex}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
        </dl>
      </article>;
    })}</div> : <p>No ad-hoc van was recorded for this day.</p>}
  </section>;
}
export function PerformanceTrendValues({ series, period, endDate }: { series: TrendSeries; period: TrendPeriod; endDate: string }) {
  const points = trendPeriodPoints(series.points, period, endDate);
  const periodLabel = period === "mtd" ? "MTD" : `${period}-day`;
  const last = points.at(-1);
  const recorded = points.filter((point) => point.value != null);
  const total = recordedTrendTotal(series, points);
  const vanSummary = isAdHocVanSeries(series) ? vanPeriodSummary(points) : null;
  return <>
    <div className="review-history-totals">
      <div><small>{last ? dayLabel(last.date) : "Selected day"}</small><strong>{formatTrendValue(last?.value ?? null, series.unit)}</strong></div>
      {total != null ? <div><small>{periodLabel} recorded total</small><strong>{formatTrendValue(total, series.unit)}</strong></div> : null}
    </div>
    {vanSummary ? <div className="review-history-van-summary" aria-label={`${periodLabel} ad-hoc van summary`}>
      <span><strong>{count(vanSummary.vans)}</strong> vans</span>
      <span><strong>{vanSummary.delivered == null ? "—" : count(vanSummary.delivered)}</strong> delivered</span>
      <span><strong>{vanSummary.shipments == null ? "—" : count(vanSummary.shipments)}</strong> van shipments</span>
    </div> : null}
    <div className="review-history-caption"><span>Daily values · newest first</span><span>{recorded.length}/{points.length} days recorded</span></div>
    <div className="review-history-values" tabIndex={0} role="region" aria-label={`${periodLabel} daily values for ${series.label}`}>
      <div className="review-history-value-grid" role="table" aria-label={`${periodLabel} daily values for ${series.label}`}>
        <div className="review-history-value-head" role="row">
          <span role="columnheader">Date</span>
          <span role="columnheader">{series.unit === "money" ? "Amount" : series.unit === "time" ? "Time" : "Value"}</span>
        </div>
        {[...points].reverse().map((point) => {
          const missed = point.value != null && series.target != null && (series.direction === "lower" ? point.value > series.target : point.value < series.target);
          return <div className="review-history-value-row" role="row" key={point.date}>
            <span className="review-history-value-date" role="cell">
              <time dateTime={point.date}>{dayLabel(point.date)}</time>
            </span>
            <span className={`review-history-value-amount${missed ? " history-value-missed" : ""}`} role="cell" aria-label={`${dayLabel(point.date)}: ${formatTrendValue(point.value, series.unit)}`}>
              <strong>{formatTrendValue(point.value, series.unit)}</strong>
              {missed ? <small>Off target</small> : null}
            </span>
            {point.note && point.note !== "Hawkeye D-1" ? <small className="review-history-value-meta" title={trendPointDetail(series, point)}>{trendPointDetail(series, point)}</small> : null}
          </div>;
        })}
      </div>
    </div>
  </>;
}
