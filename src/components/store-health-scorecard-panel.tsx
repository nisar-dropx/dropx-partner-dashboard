"use client";

import { useMemo, useState } from "react";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import { formatDashboardDate } from "@/lib/date-format";
import {
  storeHealthCategoryLabel,
  storeHealthCategoryOrder,
  storeHealthMetricCategory,
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

function definitionOrder(key: string) {
  const index = storeHealthMetricDefinitions.findIndex((entry) => entry.key === key);
  return index < 0 ? 999 : index;
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

function groupMetrics(metrics: StoreHealthReviewMetric[]) {
  const byCategory = new Map<string, StoreHealthReviewMetric[]>();
  for (const metric of metrics) {
    const category = metric.category || storeHealthMetricCategory(metric.key);
    const list = byCategory.get(category) ?? [];
    list.push(metric);
    byCategory.set(category, list);
  }
  const orderedCategories = [
    ...storeHealthCategoryOrder.filter((category) => byCategory.has(category)),
    ...[...byCategory.keys()].filter((category) => !storeHealthCategoryOrder.includes(category))
  ];
  return orderedCategories.map((category) => {
    const rows = (byCategory.get(category) ?? []).sort((left, right) => definitionOrder(left.key) - definitionOrder(right.key));
    return {
      category,
      label: storeHealthCategoryLabel(category),
      rows,
      red: rows.filter((row) => row.severity === "red").length,
      amber: rows.filter((row) => row.severity === "amber").length,
      green: rows.filter((row) => row.severity === "green").length,
      neutral: rows.filter((row) => row.severity === "neutral").length
    };
  });
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

  const displayMetrics = useMemo(() => {
    if (mode === "day") return metrics;
    if (metrics.length) return metrics;
    const fallback = historyNewestFirst.find((day) => day.metrics.length)?.metrics ?? [];
    return fallback;
  }, [mode, metrics, historyNewestFirst]);

  const groups = useMemo(() => groupMetrics(displayMetrics), [displayMetrics]);

  return (
    <ReviewDetails className="performance-inline-detail review-scorecard store-health-scorecard-panel" open>
      <summary>
        <span>Performance scorecard</span>
        <b>{misses.length} misses · {metrics.length} metrics · {groups.length} groups</b>
      </summary>
      <div className="review-scorecard-toolbar">
        <span>Grouped as in the Store Health PDF · Green full · Amber half · Red zero</span>
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
      ) : mode === "compare7" && !displayMetrics.length ? (
        <p className="review-scorecard-empty">No Store Health imports in the last 7 days for this store yet.</p>
      ) : (
        <div className={`store-health-metric-groups${mode === "compare7" ? " store-health-metrics-compare" : ""}`}>
          {groups.map((group) => (
            <section className="store-health-metric-group" key={group.category} aria-label={group.label}>
              <header className="store-health-metric-group-head">
                <div>
                  <h4>{group.label}</h4>
                  <p>{group.rows.length} metric{group.rows.length === 1 ? "" : "s"}</p>
                </div>
                <div className="store-health-metric-group-counts" aria-label={`${group.label} status counts`}>
                  {group.red ? <em className="red">{group.red} red</em> : null}
                  {group.amber ? <em className="amber">{group.amber} amber</em> : null}
                  {group.green ? <em className="green">{group.green} green</em> : null}
                  {group.neutral ? <em className="neutral">{group.neutral} n/a</em> : null}
                </div>
              </header>
              <div className="performance-review-metrics">
                {group.rows.map((metric) => {
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
                    <article className={displayMetric.severity} key={metric.key} title={metric.label}>
                      <span>{metric.short}</span>
                      <strong>{formatActual(displayMetric)}</strong>
                      <small>{displayMetric.severity === "neutral" ? "Not scored" : `Target ${definition?.targetText ?? "—"}`}</small>
                      {mode === "compare7" ? (
                        <div className="store-health-metric-trend">
                          <Sparkline values={series} tone={displayMetric.severity}/>
                          {delta ? <em className={delta.tone} title={delta.label}>{delta.text}</em> : <em className="flat">—</em>}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </ReviewDetails>
  );
}
