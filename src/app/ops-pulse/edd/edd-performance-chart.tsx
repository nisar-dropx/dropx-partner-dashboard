"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EddPerformanceNetworkStation } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity } from "./edd-performance-severity";

const ROW_HEIGHT = 30;
const ROW_GAP = 8;
const LABEL_WIDTH = 64;
const TOP_N = 10;

/**
 * Ranks the stations with the worst delivery performance today — worst
 * first, so a manager scanning the network sees exactly who needs help
 * without having to sort the table themselves. Bar length is the
 * percentage itself (a fixed 0-100 scale, not relative to the worst value),
 * so bar length is directly comparable across the whole chart; color comes
 * from the same good/watch/critical severity as the table's pills.
 */
export function EddPerformanceChart({ stations }: { stations: EddPerformanceNetworkStation[] }) {
  const router = useRouter();
  const [hovered, setHovered] = useState<string | null>(null);
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

  const ranked = [...stations]
    .filter((row) => row.assigned > 0)
    .sort((a, b) => a.deliveredPct - b.deliveredPct)
    .slice(0, TOP_N);

  if (!ranked.length) {
    return <p className="subtle">No stations have performance data yet today.</p>;
  }

  const plotWidth = Math.max(120, containerWidth - LABEL_WIDTH - 56);
  const height = ranked.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;

  return (
    <div className="edd-network-chart" ref={containerRef}>
      <svg width="100%" height={height} role="img" aria-label="Stations with the lowest delivery performance today">
        {ranked.map((row, index) => {
          const barWidth = Math.max(3, (row.deliveredPct / 100) * plotWidth);
          const y = index * (ROW_HEIGHT + ROW_GAP);
          const isHovered = hovered === row.stationCode;
          const severity = deliverySeverity(row.deliveredPct);
          return (
            <g
              key={row.stationCode}
              className="edd-network-chart-row"
              onMouseEnter={() => setHovered(row.stationCode)}
              onMouseLeave={() => setHovered((current) => (current === row.stationCode ? null : current))}
              onClick={() => router.push(`/edd/${encodeURIComponent(row.stationCode)}/performance`)}
              style={{ cursor: "pointer" }}
            >
              <text x={0} y={y + ROW_HEIGHT / 2 + 4} className="edd-network-chart-label">{row.stationCode}</text>
              <rect x={LABEL_WIDTH} y={y} width={plotWidth} height={ROW_HEIGHT} rx={4} className="edd-chart-track" />
              <rect
                x={LABEL_WIDTH}
                y={y}
                width={barWidth}
                height={ROW_HEIGHT}
                rx={4}
                className={`edd-performance-chart-bar ${severity}${isHovered ? " hovered" : ""}`}
              />
              <text x={LABEL_WIDTH + barWidth + 8} y={y + ROW_HEIGHT / 2 + 4} className="edd-network-chart-value">
                {row.deliveredPct}%
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
