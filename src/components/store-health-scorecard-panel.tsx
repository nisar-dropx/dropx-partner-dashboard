"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ReviewDetails, ReviewDetailsClose } from "@/components/review-details";
import { formatDashboardDateMedium } from "@/lib/date-format";
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

type DayPoint = {
  date: string;
  value: number | null;
  evidence: string | null;
  severity: StoreHealthReviewMetric["severity"];
};

function formatActual(metric: Pick<StoreHealthReviewMetric, "evidence" | "severity" | "actual">) {
  if (metric.evidence) return metric.evidence;
  if (metric.severity === "neutral" && metric.actual == null) return "Not scored";
  if (metric.actual == null) return "—";
  return String(metric.actual);
}

function definitionOrder(key: string) {
  const index = storeHealthMetricDefinitions.findIndex((entry) => entry.key === key);
  return index < 0 ? 999 : index;
}

function dayLabel(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  return formatDashboardDateMedium(date).replace(/\s+\d{4}$/, "");
}

function MiniBarTrend({
  points,
  selectedDate,
  compact = false
}: {
  points: DayPoint[];
  selectedDate?: string;
  compact?: boolean;
}) {
  const numeric = points.map((point) => point.value).filter((value): value is number => value != null);
  const max = numeric.length ? Math.max(...numeric.map((value) => Math.abs(value)), 1e-9) : 1;
  const height = compact ? 22 : 28;
  if (!points.length) {
    return <span className="store-health-bars empty" aria-hidden="true"/>;
  }
  return (
    <div className={`store-health-bars${compact ? " compact" : ""}`} role="img" aria-label="Seven day trend" style={{ height }}>
      {points.map((point) => {
        const hasValue = point.value != null;
        const ratio = hasValue ? Math.max(0.12, Math.abs(point.value as number) / max) : 0;
        const barHeight = hasValue ? Math.round(ratio * (height - 2)) : 2;
        return (
          <span
            key={point.date}
            className={`store-health-bar ${point.severity}${selectedDate === point.date ? " selected" : ""}${hasValue ? "" : " missing"}`}
            title={`${dayLabel(point.date)}: ${point.evidence || (hasValue ? String(point.value) : "No data")}`}
            style={{ height: `${barHeight}px` }}
          />
        );
      })}
    </div>
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

function MetricDetailModal({
  metric,
  definition,
  points,
  selectedDate,
  delta,
  onClose
}: {
  metric: StoreHealthReviewMetric;
  definition: (typeof storeHealthMetricDefinitions)[number] | undefined;
  points: DayPoint[];
  selectedDate: string;
  delta: ReturnType<typeof compareDelta>;
  onClose: () => void;
}) {
  const titleId = useId();
  const selected = points.find((point) => point.date === selectedDate) ?? null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop store-health-metric-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modal-panel store-health-metric-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <div>
            <p className="store-health-metric-modal-kicker">{definition ? storeHealthCategoryLabel(definition.category) : "Store Health"}</p>
            <h2 id={titleId}>{metric.label}</h2>
          </div>
          <button type="button" className="button secondary" onClick={onClose}>Close</button>
        </header>
        <div className="store-health-metric-modal-body">
          <div className="store-health-metric-modal-facts">
            <article className={metric.severity}>
              <span>Selected day</span>
              <strong>{formatActual(metric)}</strong>
              <small>{formatDashboardDateMedium(selectedDate)} · {metric.severity === "neutral" ? "Not scored" : metric.severity}</small>
            </article>
            <article>
              <span>Target</span>
              <strong>{definition?.targetText ?? "—"}</strong>
              <small>{definition?.direction === "lower" ? "Lower is better" : "Higher is better"} · weight {definition?.weight ?? "—"}</small>
            </article>
            <article>
              <span>vs 7-day avg</span>
              <strong className={delta?.tone ?? "flat"}>{delta?.text ?? "—"}</strong>
              <small>{delta?.label ?? "Need more imported days"}</small>
            </article>
          </div>
          <div className="store-health-metric-modal-chart">
            <div className="store-health-metric-modal-chart-head">
              <h3>Last 7 days</h3>
              <small>Oldest → newest · coloured by day status</small>
            </div>
            <MiniBarTrend points={points} selectedDate={selectedDate}/>
            <ol className="store-health-metric-modal-days">
              {points.map((point) => (
                <li key={point.date} className={`${point.severity}${point.date === selectedDate ? " selected" : ""}`}>
                  <span>{dayLabel(point.date)}</span>
                  <strong>{point.evidence || (point.value == null ? "No data" : String(point.value))}</strong>
                  <em>{point.severity === "neutral" ? "n/a" : point.severity}</em>
                </li>
              ))}
            </ol>
          </div>
          {selected?.evidence ? <p className="store-health-metric-modal-note">Selected day evidence: {selected.evidence}</p> : null}
        </div>
      </section>
    </div>
  );
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
  const [activeKey, setActiveKey] = useState<string | null>(null);
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

  const seriesByKey = useMemo(() => {
    const map = new Map<string, DayPoint[]>();
    for (const definition of storeHealthMetricDefinitions) {
      map.set(
        definition.key,
        historyOldestFirst.map((day) => {
          const entry = day.metrics.find((metric) => metric.key === definition.key);
          return {
            date: day.date,
            value: entry?.actual ?? null,
            evidence: entry?.evidence ?? null,
            severity: entry?.severity ?? "neutral"
          };
        })
      );
    }
    return map;
  }, [historyOldestFirst]);

  const activeMetric = activeKey
    ? displayMetrics.find((metric) => metric.key === activeKey)
      ?? metrics.find((metric) => metric.key === activeKey)
      ?? null
    : null;
  const activeDefinition = activeMetric
    ? storeHealthMetricDefinitions.find((entry) => entry.key === activeMetric.key)
    : undefined;
  const activePoints = activeMetric ? (seriesByKey.get(activeMetric.key) ?? []) : [];
  const activeSelectedActual = activeMetric
    ? (activePoints.find((point) => point.date === date)?.value ?? activeMetric.actual)
    : null;
  const activeDelta = activeMetric
    ? compareDelta(activeSelectedActual, activePoints.filter((point) => point.date !== date).map((point) => point.value), activeMetric.direction)
    : null;

  return (
    <ReviewDetails className="performance-inline-detail review-scorecard store-health-scorecard-panel" open>
      <summary>
        <span>Performance scorecard</span>
        <b>{misses.length} misses · {metrics.length} metrics · {groups.length} groups</b>
      </summary>
      <div className="review-scorecard-toolbar">
        <span>PDF groups · tap a card for full detail · bars = last 7 days</span>
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
          ? `Imported Store Health for ${formatDashboardDateMedium(date)} (D-2). Each card shows the 7-day bar trend.`
          : daysWithData
            ? `Comparing ${daysWithData} imported day${daysWithData === 1 ? "" : "s"} ending ${formatDashboardDateMedium(date)}. Bars read oldest → newest.`
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
            <small>{formatDashboardDateMedium(date)}</small>
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
                <h4>{group.label}<small>{group.rows.length}</small></h4>
                <div className="store-health-metric-group-counts" aria-label={`${group.label} status counts`}>
                  {group.red ? <em className="red">{group.red}</em> : null}
                  {group.amber ? <em className="amber">{group.amber}</em> : null}
                  {group.green ? <em className="green">{group.green}</em> : null}
                  {group.neutral ? <em className="neutral">{group.neutral}</em> : null}
                </div>
              </header>
              <div className="performance-review-metrics">
                {group.rows.map((metric) => {
                  const definition = storeHealthMetricDefinitions.find((entry) => entry.key === metric.key);
                  const points = seriesByKey.get(metric.key) ?? [];
                  const selectedActual = points.find((point) => point.date === date)?.value
                    ?? (metrics.length ? metric.actual : null);
                  const prior = points.filter((point) => point.date !== date).map((point) => point.value);
                  const delta = compareDelta(selectedActual, prior, metric.direction);
                  const displayMetric = mode === "compare7" && !metrics.length
                    ? { ...metric, actual: selectedActual, evidence: selectedActual == null ? "No data" : metric.evidence, severity: selectedActual == null ? "neutral" as const : metric.severity }
                    : metric;
                  return (
                    <button
                      type="button"
                      className={`store-health-metric-card ${displayMetric.severity}`}
                      key={metric.key}
                      title={`${metric.label} · open details`}
                      onClick={() => setActiveKey(metric.key)}
                    >
                      <span>{metric.short}</span>
                      <strong>{formatActual(displayMetric)}</strong>
                      <small>{displayMetric.severity === "neutral" ? "Not scored" : `Target ${definition?.targetText ?? "—"}`}</small>
                      <div className="store-health-metric-trend">
                        <MiniBarTrend points={points} selectedDate={date} compact/>
                        {delta ? <em className={delta.tone} title={delta.label}>{delta.text}</em> : <em className="flat">—</em>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {activeMetric ? (
        <MetricDetailModal
          metric={activeMetric}
          definition={activeDefinition}
          points={activePoints}
          selectedDate={date}
          delta={activeDelta}
          onClose={() => setActiveKey(null)}
        />
      ) : null}
    </ReviewDetails>
  );
}
