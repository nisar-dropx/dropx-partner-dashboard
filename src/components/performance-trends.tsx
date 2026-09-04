"use client";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { PerformanceTrendValues, trendPeriodPoints, type TrendPeriod } from "@/components/performance-trend-values";
import {
  formatTrendValue,
  trendGeometry,
  type TrendGroup,
  type TrendResponse,
  type TrendSeries,
} from "@/lib/ops-pulse/review-trends";

type Selection = { group: TrendGroup; metric: string; label: string };
const Context = createContext<{
  open: (selection: Selection, button: HTMLButtonElement) => void;
  active: string | null;
} | null>(null);
export function TrendButton({
  group,
  metric,
  label,
  variant = "label",
}: {
  group: TrendGroup;
  metric: string;
  label: string;
  variant?: "label" | "card";
}) {
  const context = useContext(Context);
  if (!context) return null;
  return (
    <button
      type="button"
      className={`review-trend-button ${variant === "card" ? "review-trend-card" : ""}`}
      title={`${label} · daily values and history`}
      aria-label={`View ${label} history`}
      aria-haspopup="dialog"
      aria-expanded={context.active === `${group}:${metric}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        context.open({ group, metric, label }, event.currentTarget);
      }}
    >
      {variant === "card" ? null : <span>History</span>}
    </button>
  );
}
export function PerformanceTrendProvider({
  station,
  date,
  children,
}: {
  station: string;
  date: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState<Selection | null>(null),
    [period, setPeriod] = useState<TrendPeriod>(7),
    [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<TrendResponse | null>(null),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0),
    [position, setPosition] = useState({ left: 12, top: 60, width: 440 });
  const [highlight, setHighlight] = useState<number | null>(null);
  const cache = useRef(new Map<string, TrendResponse>()),
    anchor = useRef<HTMLButtonElement | null>(null),
    triggerKey = useRef<string | null>(null),
    dialog = useRef<HTMLDivElement | null>(null),
    closeButton = useRef<HTMLButtonElement | null>(null);
  const id = useId(),
    group = active?.group;
  function close() {
    setActive(null);
    setExpanded(false);
    anchor.current?.focus();
  }
  function open(selection: Selection, button: HTMLButtonElement) {
    if (anchor.current === button && active) {
      close();
      return;
    }
    anchor.current = button;
    triggerKey.current = `${selection.group}:${selection.metric}`;
    setActive(selection);
    setExpanded(false);
    setHighlight(null);
    setPeriod((current) => selection.group === "cost" || current !== "mtd" ? current : 7);
  }
  useEffect(() => {
    if (!group) return;
    setError(null);
    setData(cache.current.get(group) ?? null);
    if (cache.current.has(group)) return;
    let cancelled = false;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 58000);
    fetch(
      `/api/ops-pulse/performance/trends?${new URLSearchParams({ station, date, group })}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Unable to load trend.");
        return body as TrendResponse;
      })
      .then((body) => {
        if (!controller.signal.aborted) {
          cache.current.set(group, body);
          setData(body);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load trend.");
        else setError("Loading took too long. Please retry.");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [group, station, date, retry]);
  useEffect(() => {
    if (!active) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(expanded ? 960 : 440, window.innerWidth - 24),
        height = Math.min(expanded ? 720 : 550, window.innerHeight - 24);
      setPosition({
        width,
        left: expanded
          ? (window.innerWidth - width) / 2
          : Math.max(
              12,
              Math.min(rect.right - width, window.innerWidth - width - 12),
            ),
        top: expanded
          ? 12
          : Math.max(
              12,
              Math.min(rect.bottom + 6, window.innerHeight - height - 12),
            ),
      });
    };
    place();
    if (!dialog.current?.contains(document.activeElement))
      closeButton.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (
        !dialog.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab" && expanded) {
        const focusable = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            "button,select,[tabindex='0']",
          ) ?? [],
        ).filter((e) => !e.hasAttribute("disabled"));
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, expanded]);
  const series = data?.series.find((s) => s.key === active?.metric),
    points = series ? trendPeriodPoints(series.points, period, date) : [],
    geometry = trendGeometry(points, series?.target);
  const valid = points.filter((p) => p.value != null),
    latest = valid.at(-1),
    first = valid[0],
    delta = latest && first ? latest.value! - first.value! : null;
  const selected = highlight == null ? points.at(-1) : points[highlight];
  const changeMeasure = (value: string) => {
    if (!active) return;
    const next = data?.series.find((s) => s.key === value);
    if (next) {
      setActive({ ...active, metric: next.key, label: next.label });
      setHighlight(null);
    }
  };
  return (
    <Context.Provider
      value={{ open, active: active ? triggerKey.current : null }}
    >
      {children}
      {active
        ? createPortal(
            <>
              {expanded ? <div className="review-trend-backdrop" /> : null}
              <div
                ref={dialog}
                role="dialog"
                aria-modal={expanded || undefined}
                aria-labelledby={id}
                className={`review-trend-popover ${expanded ? "expanded" : ""}`}
                style={position}
              >
                <header>
                  <div>
                    <strong id={id}>{series?.label ?? active.label}</strong>
                    <small>
                      {station} · through {date.split("-").reverse().join("/")}
                    </small>
                  </div>
                  <button
                    ref={closeButton}
                    type="button"
                    aria-label="Close trend"
                    onClick={close}
                  >
                    ×
                  </button>
                </header>
                <div className="review-trend-controls">
                  <div role="group" aria-label="Trend period">
                    {([7, 14, ...(group === "cost" ? ["mtd" as const] : [])] as const).map((value) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={period === value}
                        onClick={() => {
                          setPeriod(value);
                          setHighlight(null);
                        }}
                      >
                        {value === "mtd" ? "MTD" : `${value} days`}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => setExpanded(!expanded)}>
                    {expanded ? "Numbers only" : "Graph & details"}
                  </button>
                </div>
                {error ? (
                  <div role="alert" className="review-trend-message">
                    {error}
                    <button
                      type="button"
                      onClick={() => {
                        cache.current.delete(active.group);
                        setRetry((v) => v + 1);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ) : !data ? (
                  <p role="status" className="review-trend-message">
                    Loading trend…
                  </p>
                ) : !series ? (
                  <p className="review-trend-message">
                    No trend is available for this metric.
                  </p>
                ) : (
                  <>
                    {data.series.length > 1 ? (
                      <label className="review-trend-measure">
                        Measure
                        <select
                          value={series.key}
                          onChange={(e) => changeMeasure(e.target.value)}
                        >
                          {data.series.map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {!expanded ? <PerformanceTrendValues series={series} period={period} endDate={date}/> : <div className="review-trend-summary">
                      <strong>
                        {formatTrendValue(selected?.value ?? null, series.unit)}
                      </strong>
                      <span>
                        {selected?.date ?? "No recorded values"}
                        {selected?.note ? <small>{selected.note}</small> : null}
                      </span>
                      <small>
                        {valid.length}/{points.length} days available
                        {delta != null && valid.length > 1
                          ? ` · ${delta > 0 ? "+" : ""}${series.unit === "time" ? `${Math.round(delta)} min` : series.unit === "percent" ? `${delta.toFixed(1)} pp` : formatTrendValue(delta, series.unit)} change`
                          : ""}
                      </small>
                    </div>}
                    {expanded && (valid.length ? (
                      <svg
                        className="review-trend-chart"
                        viewBox="0 0 400 174"
                        role="img"
                        aria-label={`${series.label}: ${valid.length} recorded days. Missing days are gaps.`}
                      >
                        <line
                          x1="34"
                          y1="142"
                          x2="370"
                          y2="142"
                          className="trend-axis"
                        />
                        {geometry.targetY != null ? (
                          <line
                            x1="34"
                            x2="370"
                            y1={geometry.targetY}
                            y2={geometry.targetY}
                            className="trend-target"
                          />
                        ) : null}
                        <text x="34" y="12">
                          {formatTrendValue(geometry.max, series.unit)}
                        </text>
                        <text x="34" y="171">
                          {points[0]?.date.slice(5)}
                        </text>
                        <text x="370" y="171" textAnchor="end">
                          {points.at(-1)?.date.slice(5)}
                        </text>
                        {geometry.segments.map((segment, index) => (
                          <polyline
                            key={index}
                            points={segment}
                            fill="none"
                            className="trend-line"
                          />
                        ))}
                        {geometry.dots.map((dot, index) =>
                          dot.y == null ? (
                            <g key={dot.date}>
                              <path
                                d={`M${dot.x - 2},139l4,6m-4,0l4,-6`}
                                className="trend-gap"
                              />
                              <title>{dot.date}: No data</title>
                            </g>
                          ) : (
                            <circle
                              key={dot.date}
                              cx={dot.x}
                              cy={dot.y}
                              r={highlight === index ? 5 : 3.5}
                              tabIndex={0}
                              aria-label={`${dot.date}: ${formatTrendValue(dot.value, series.unit)}`}
                              onFocus={() => setHighlight(index)}
                              onMouseEnter={() => setHighlight(index)}
                              onClick={() => setHighlight(index)}
                              className={
                                series.target == null
                                  ? "trend-dot"
                                  : (
                                        series.direction === "lower"
                                          ? dot.value! <= series.target
                                          : dot.value! >= series.target
                                      )
                                    ? "trend-dot met"
                                    : "trend-dot missed"
                              }
                            >
                              <title>
                                {dot.date}:{" "}
                                {formatTrendValue(dot.value, series.unit)}
                              </title>
                            </circle>
                          ),
                        )}
                      </svg>
                    ) : (
                      <p className="review-trend-message">
                        No recorded data in this period.
                      </p>
                    ))}
                    {series.target != null ? (
                      <p className="review-trend-target">
                        {expanded ? "Dashed line · current target" : "Current target"}{" "}
                        {series.direction === "lower" ? "≤" : "≥"}{" "}
                        {formatTrendValue(series.target, series.unit)}
                      </p>
                    ) : null}
                    {expanded ? (
                      <div className="review-trend-table">
                        <table>
                          <caption>Daily values · {station}</caption>
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>{series.label}</th>
                              <th>Detail</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...points].reverse().map((point) => (
                              <tr key={point.date}>
                                <td>{point.date}</td>
                                <td>
                                  {formatTrendValue(point.value, series.unit)}
                                </td>
                                <td>{point.note || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    <p className="review-trend-note">{series.note}</p>
                  </>
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </Context.Provider>
  );
}
