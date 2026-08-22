"use client";

import { useMemo, useState } from "react";

export type EddTrendPoint = { date: string; count: number };

const BAR_WIDTH = 14;
const BAR_GAP = 6;
const SLOT = BAR_WIDTH + BAR_GAP;
const PLOT_HEIGHT = 130;
const AXIS_HEIGHT = 26;
const GRID_LINES = 4;
const MAX_X_LABELS = 12;

function formatShortDate(ymd: string) {
  const parsed = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) return ymd;
  return parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

function formatFullDate(ymd: string) {
  const parsed = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) return ymd;
  return parsed.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function bucketOf(date: string, todayYmd: string): "overdue" | "today" | "future" {
  if (date < todayYmd) return "overdue";
  if (date === todayYmd) return "today";
  return "future";
}

export function EddTrendChart({ points, todayYmd }: { points: EddTrendPoint[]; todayYmd: string }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const maxCount = Math.max(1, ...points.map((point) => point.count));
  const width = Math.max(points.length * SLOT + 8, 360);
  const labelEvery = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));

  const gridValues = useMemo(() => {
    const step = maxCount / GRID_LINES;
    return Array.from({ length: GRID_LINES + 1 }, (_, index) => Math.round(step * index));
  }, [maxCount]);

  if (!points.length) return null;
  const hoveredPoint = hovered != null ? points[hovered] : undefined;

  return (
    <div className="edd-chart">
      <div className="edd-chart-legend">
        <span><i className="edd-legend-dot overdue" aria-hidden="true" /> Overdue days</span>
        <span><i className="edd-legend-dot today" aria-hidden="true" /> Today</span>
        <span><i className="edd-legend-dot future" aria-hidden="true" /> Upcoming</span>
      </div>
      <div className="edd-chart-scroll">
        <div className="edd-chart-inner" style={{ width }}>
          <svg width={width} height={PLOT_HEIGHT + AXIS_HEIGHT} role="img" aria-label="Live tracking IDs by day-level EAD">
            {gridValues.map((value, index) => {
              const y = PLOT_HEIGHT - (value / maxCount) * (PLOT_HEIGHT - 12);
              return (
                <g key={`grid-${value}-${index}`}>
                  <line x1={0} x2={width} y1={y} y2={y} className="edd-chart-gridline" />
                  <text x={0} y={y - 4} className="edd-chart-gridlabel">{value.toLocaleString("en-IN")}</text>
                </g>
              );
            })}
            {points.map((point, index) => {
              const barHeight = Math.max(2, (point.count / maxCount) * (PLOT_HEIGHT - 12));
              const x = index * SLOT;
              const y = PLOT_HEIGHT - barHeight;
              const bucket = bucketOf(point.date, todayYmd);
              const showLabel = index % labelEvery === 0 || index === points.length - 1;
              return (
                <g key={point.date}>
                  <rect x={x} y={0} width={BAR_WIDTH} height={PLOT_HEIGHT} rx={3} className="edd-chart-track" />
                  <rect
                    x={x}
                    y={y}
                    width={BAR_WIDTH}
                    height={barHeight}
                    rx={3}
                    className={`edd-chart-bar ${bucket}${hovered === index ? " hovered" : ""}`}
                    onMouseEnter={() => setHovered(index)}
                    onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
                  />
                  {showLabel ? (
                    <text x={x + BAR_WIDTH / 2} y={PLOT_HEIGHT + 18} textAnchor="middle" className="edd-chart-xlabel">
                      {formatShortDate(point.date)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {hovered != null && hoveredPoint ? (
            <div className="edd-chart-tooltip" style={{ left: hovered * SLOT + BAR_WIDTH / 2 }}>
              <strong>{hoveredPoint.count.toLocaleString("en-IN")} TIDs</strong>
              <span>{formatFullDate(hoveredPoint.date)}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
