"use client";

import type { ReviewMetric } from "@/components/performance-review-desk";
import { TrendButton } from "@/components/performance-trends";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";

const valueText = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;

export function ReviewScorecard({ metrics }: { metrics: ReviewMetric[] }) {
  const misses = metrics.filter(metric => metric.severity === "red" || metric.severity === "amber");
  return <ReviewDetails className="performance-inline-detail review-scorecard" open>
    <summary><span>Performance scorecard</span><b>{misses.length} misses · {metrics.length} metrics</b></summary>
    <div className="review-scorecard-toolbar">
      <span>All performance metrics · misses highlighted</span>
      <ReviewDetailsClose label="Close performance scorecard"/>
    </div>
    <p className="review-history-hint">Selected day’s uploaded metrics · tap a metric for history.</p>
    {!metrics.length ? <p className="review-scorecard-empty">No metrics uploaded for this day.</p> : <div className="performance-review-metrics">{metrics.map(metric => <article className={metric.severity} key={metric.key}>
      <span title={metric.label}>{metric.short}</span><strong>{valueText(metric.actual)}</strong>
      <small>{metric.target == null ? "Target not configured" : `Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}</small>
      <TrendButton group="performance" metric={metric.key} label={metric.short} variant="card"/>
    </article>)}</div>}
  </ReviewDetails>;
}
