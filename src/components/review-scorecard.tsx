"use client";

import { useState } from "react";
import type { ReviewMetric } from "@/components/performance-review-desk";
import { TrendButton } from "@/components/performance-trends";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";

const valueText = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;

export function ReviewScorecard({ metrics }: { metrics: ReviewMetric[] }) {
  const [showAll, setShowAll] = useState(false);
  const misses = metrics.filter(metric => metric.severity === "red" || metric.severity === "amber");
  const visible = showAll ? metrics : misses;
  return <ReviewDetails className="performance-inline-detail review-scorecard" open>
    <summary><span>Performance scorecard</span><b>{misses.length} misses · {metrics.length} metrics</b></summary>
    <div className="review-scorecard-toolbar">
      <div className="review-attendance-period" role="group" aria-label="Scorecard view">
        <button type="button" aria-pressed={!showAll} onClick={()=>setShowAll(false)}>Needs attention ({misses.length})</button>
        <button type="button" aria-pressed={showAll} onClick={()=>setShowAll(true)}>All metrics ({metrics.length})</button>
      </div>
      <ReviewDetailsClose label="Close performance scorecard"/>
    </div>
    <p className="review-history-hint">Selected day’s uploaded metrics · tap a metric for history.</p>
    {!visible.length ? <p className="review-scorecard-empty">{metrics.length ? "No performance misses. View All metrics for the full scorecard." : "No metrics uploaded for this day."}</p> : <div className="performance-review-metrics">{visible.map(metric => <article className={metric.severity} key={metric.key}>
      <span title={metric.label}>{metric.short}</span><strong>{valueText(metric.actual)}</strong>
      <small>{metric.target == null ? "Reference metric" : `Target ${metric.direction === "higher" ? "≥" : "≤"} ${valueText(metric.target)}`}</small>
      <TrendButton group="performance" metric={metric.key} label={metric.short} variant="card"/>
    </article>)}</div>}
  </ReviewDetails>;
}
