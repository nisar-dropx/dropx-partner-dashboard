"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type EddTrendPoint = { date: string; count: number };

const BAR_GAP = 6;
const MIN_SLOT = 10;
const MAX_SLOT = 34;
const PLOT_HEIGHT = 130;
const AXIS_HEIGHT = 26;
const GRID_LINES = 4;
/** Minimum horizontal pixels between two x-axis labels so they never overlap. */
const MIN_LABEL_GAP_PX = 56;

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

/**
 * Picks x-axis label indices with a guaranteed minimum pixel gap between
 * them — fixed-interval thinning alone (every Nth bar) still lets the last
 * forced label land right next to the previous one when the count doesn't
 * divide evenly, which is what produced overlapping trailing dates before.
 */
function pickLabelIndices(count: number, slot: number): Set<number> {
  if (count <= 1) return new Set([0]);
  const minStep = Math.max(1, Math.round(MIN_LABEL_GAP_PX / slot));
  const indices: number[] = [];
  for (let i = 0; i < count; i += minStep) indices.push(i);
  const last = count - 1;
  const previous = indices[indices.length - 1] ?? -Infinity;
  if (previous !== last) {
    if ((last - previous) * slot >= MIN_LABEL_GAP_PX * 0.6) {
      indices.push(last);
    } else {
      indices[indices.length - 1] = last;
    }
  }
  return new Set(indices);
}

export function EddTrendChart({ points, todayYmd }: { points: EddTrendPoint[]; todayYmd: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const maxCount = Math.max(1, ...points.map((point) => point.count));
  // Fill the available width when there's room for generous bars; fall back
  // to a fixed minimum slot (with horizontal scroll) once the day count
  // would otherwise squeeze bars past legibility.
  const naturalSlot = points.length ? containerWidth / points.length : MAX_SLOT;
  const slot = Math.min(MAX_SLOT, Math.max(MIN_SLOT, naturalSlot || MAX_SLOT));
  const barWidth = Math.max(3, slot - BAR_GAP);
  const width = Math.max(containerWidth, slot * points.length);
  const labelIndices = useMemo(() => pickLabelIndices(points.length, slot), [points.length, slot]);

  const gridValues = useMemo(() => {
    const step = maxCount / GRID_LINES;
    return Array.from({ length: GRID_LINES + 1 }, (_, index) => Math.round(step * index));
  }, [maxCount]);

  const hoveredPoint = hovered != null ? points[hovered] : undefined;

  return (
    <div className="edd-chart" ref={containerRef}>
      <div className="edd-chart-legend">
        <span><i className="edd-legend-dot overdue" aria-hidden="true" /> Overdue days</span>
        <span><i className="edd-legend-dot today" aria-hidden="true" /> Today</span>
        <span><i className="edd-legend-dot future" aria-hidden="true" /> Upcoming</span>
      </div>
      {!points.length ? null : (
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
                const x = index * slot;
                const y = PLOT_HEIGHT - barHeight;
                const bucket = bucketOf(point.date, todayYmd);
                return (
                  <g key={point.date}>
                    <rect x={x} y={0} width={barWidth} height={PLOT_HEIGHT} rx={3} className="edd-chart-track" />
                    <rect
                      x={x}
                      y={y}
                      width={barWidth}
                      height={barHeight}
                      rx={3}
                      className={`edd-chart-bar ${bucket}${hovered === index ? " hovered" : ""}`}
                      onMouseEnter={() => setHovered(index)}
                      onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
                    />
                    {labelIndices.has(index) ? (
                      <text x={x + barWidth / 2} y={PLOT_HEIGHT + 18} textAnchor="middle" className="edd-chart-xlabel">
                        {formatShortDate(point.date)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
            {hovered != null && hoveredPoint ? (
              <div className="edd-chart-tooltip" style={{ left: hovered * slot + barWidth / 2 }}>
                <strong>{hoveredPoint.count.toLocaleString("en-IN")} TIDs</strong>
                <span>{formatFullDate(hoveredPoint.date)}</span>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
