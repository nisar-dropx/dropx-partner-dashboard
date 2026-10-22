"use client";

import { useMemo, useState } from "react";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import { formatDashboardDate } from "@/lib/date-format";
import {
  storeHealthMetricDefinitions,
  type StoreHealthHero,
  type StoreHealthReviewMetric
} from "@/lib/ops-pulse/store-health-scorecard";

export type StoreHealthHistoryDay = {
  date: string;
  metrics: StoreHealthReviewMetric[];
  hero: StoreHealthHero;
};

type ViewMode = "day" | "compare7";

function formatActual(metric: StoreHealthReviewMetric) {
  if (metric.evidence) return metric.evidence;
  if (metric.severity === "neutral" && metric.actual == null) return "Not scored";
  if (metric.actual == null) return "—";
  return String(metric.actual);
}

function severityRank(severity: StoreHealthReviewMetric["severity"]) {
  return severity === "red" ? 0 : severity === "amber" ? 1 : severity === "green" ? 2 : 3;
}

function Sparkline({ values, tone }: { values: Array<number | null>; tone: string }) {
  const points = values.map((value, index) => ({ index, value })).filter((entry) => entry.value != null) as Array<{ index: number; value: number }>;
  if (points.length < 2) {
    return <span className="store-health-spark empty" aria-hidden="true"/>;
  }
  const min = Math.min(...points.map((entry) => entry.value));
  const max = Math.max(...points.map((entry) => entry.value));
  const span = max - min || 1;
  const width = 56;
  const height = 18;
  const path = points
    .map((entry, order) => {
      const x = (entry.index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((entry.value - min) / span) * (height - 2) - 1;
      return `${order ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className={`store-health-spark ${tone}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function compareDelta(current: number | null, prior: Array<number | null>, direction: "higher" | "lower") {
  const history = prior.filter((value): value is number => value != null);
  if (current == null || !history.length) return null;
  const average = history.reduce((sum, value) => sum + value, 0) / history.length;
  const delta = current - average;
  if (Math.abs(delta) < 1e-9) return { label: "vs 7d avg", text: "Flat", tone: "flat" as const };
  const improved = direction === "higher" ? delta > 0 : delta < 0;
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(0) : Math.abs(delta) >= 1 ? delta.toFixed(1) : delta.toFixed(2);
  return {
    label: "vs 7d avg",
    text: `${delta > 0 ? "+" : ""}${rounded}`,
    tone: improved ? ("up" as const) : ("down" as const)
  };
}

export function StoreHealthScorecardPanel({
  metrics,
  history,
  date
}: {
  metrics: StoreHealthReviewMetric[];
  history: StoreHealthHistoryDay[];
  date: string;
}) {
  const [mode, setMode] = useState<ViewMode>("day");
  const misses = metrics.filter((metric) => metric.severity === "red" || metric.severity === "amber");
  const ordered = useMemo(
    () => [...metrics].sort((left, right) =>
      severityRank(left.severity) - severityRank(right.severity)
      || left.short.localeCompare(right.short)
    ),
    [metrics]
  );
  const historyNewestFirst = useMemo(
    () => [...history].sort((left, right) => right.date.localeCompare(left.date)),
    [history]
  );
  const historyOldestFirst = useMemo(
    () => [...historyNewestFirst].reverse(),
    [historyNewestFirst]
  );
  const daysWithData = historyNewestFirst.filter((day) => day.metrics.some((metric) => metric.severity !== "neutral" || metric.actual != null)).length;
  const compareHero = useMemo(() => {
    const scoredDays = historyNewestFirst.filter((day) => day.hero.scorePct != null);
    if (!scoredDays.length) return null;
    const average = scoredDays.reduce((sum, day) => sum + (day.hero.scorePct as number), 0) / scoredDays.length;
    const selectedDay = historyNewestFirst.find((day) => day.date === date) ?? null;
    return {
      average,
      selectedScore: selectedDay?.hero.scorePct ?? null,
      days: scoredDays.length
    };
  }, [historyNewestFirst, date]);

  const compareMetrics = useMemo(() => {
    if (metrics.length) return ordered;
    // Selected day missing an import — still render catalog rows from the newest history day that has data.
    const fallback = historyNewestFirst.find((day) => day.metrics.length)?.metrics ?? [];
    return [...fallback].sort((left, right) =>
      severityRank(left.severity) - severityRank(right.severity)
      || left.short.localeCompare(right.short)
    );
  }, [metrics.length, ordered, historyNewestFirst]);

  return (
    <ReviewDetails className="performance-inline-detail review-scorecard store-health-scorecard-panel" open>
      <summary>
        <span>Performance scorecard</span>
        <b>{misses.length} misses · {metrics.length} metrics</b>
      </summary>
      <div className="review-scorecard-toolbar">
        <span>Store Health · Green full · Amber half · Red zero</span>
        <div className="store-health-score-modes" role="group" aria-label="Scorecard view">
          <button type="button" className={mode === "day" ? "active" : ""} onClick={() => setMode("day")}>Selected day</button>
          <button type="button" className={mode === "compare7" ? "active" : ""} onClick={() => setMode("compare7")} disabled={!daysWithData}>
            Last 7 days
          </button>
        </div>
        <ReviewDetailsClose label="Close performance scorecard"/>
      </div>
      <p className="review-history-hint">
        {mode === "day"
          ? `Imported Store Health for ${formatDashboardDate(date)} (D-2).`
          : daysWithData
            ? `Comparing ${daysWithData} imported day${daysWithData === 1 ? "" : "s"} ending ${formatDashboardDate(date)}. Sparklines read oldest → newest.`
            : "No Store Health imports in the last 7 days for this store yet."}
      </p>
      {mode === "compare7" && compareHero ? (
        <div className="store-health-compare-summary" aria-label="Seven day score summary">
          <article>
            <span>7-day avg score</span>
            <strong>{compareHero.average.toFixed(1)}%</strong>
            <small>{compareHero.days} scored day{compareHero.days === 1 ? "" : "s"}</small>
          </article>
          <article>
            <span>Selected day score</span>
            <strong>{compareHero.selectedScore == null ? "—" : `${compareHero.selectedScore}%`}</strong>
            <small>{formatDashboardDate(date)}</small>
          </article>
        </div>
      ) : null}
      {mode === "day" && !metrics.length ? (
        <p className="review-scorecard-empty">No Store Health scorecard imported for this store and date.</p>
      ) : mode === "compare7" && !compareMetrics.length ? (
        <p className="review-scorecard-empty">No Store Health imports in the last 7 days for this store yet.</p>
      ) : (
        <div className={`performance-review-metrics${mode === "compare7" ? " store-health-metrics-compare" : ""}`}>
          {(mode === "compare7" ? compareMetrics : ordered).map((metric) => {
            const definition = storeHealthMetricDefinitions.find((entry) => entry.key === metric.key);
            const series = historyOldestFirst.map((day) => day.metrics.find((entry) => entry.key === metric.key)?.actual ?? null);
            const selectedActual = historyNewestFirst.find((day) => day.date === date)?.metrics.find((entry) => entry.key === metric.key)?.actual
              ?? (metrics.length ? metric.actual : null);
            const prior = series.slice(0, -1);
            const delta = mode === "compare7" ? compareDelta(selectedActual, prior, metric.direction) : null;
            const displayMetric = mode === "compare7" && !metrics.length
              ? { ...metric, actual: selectedActual, evidence: selectedActual == null ? "No data" : metric.evidence, severity: selectedActual == null ? "neutral" as const : metric.severity }
              : metric;
            return (
              <article className={displayMetric.severity} key={metric.key} title={`${metric.label}${definition?.category ? ` · ${definition.category}` : ""}`}>
                <span>{metric.short}</span>
                <strong>{formatActual(displayMetric)}</strong>
                <small>{displayMetric.severity === "neutral" ? "Not scored" : `Target ${definition?.targetText ?? "—"}`}</small>
                {mode === "compare7" ? (
                  <div className="store-health-metric-trend">
                    <Sparkline values={series} tone={displayMetric.severity}/>
                    {delta ? <em className={delta.tone} title={delta.label}>{delta.text}</em> : <em className="flat">—</em>}
                  </div>
                ) : definition?.category ? (
                  <i className="store-health-metric-cat">{definition.category.split(" ")[0]}</i>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </ReviewDetails>
  );
}
