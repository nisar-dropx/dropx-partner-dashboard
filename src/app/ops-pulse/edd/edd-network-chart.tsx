"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EddNetworkStation } from "@/lib/ops-pulse/edd-worker";

const ROW_HEIGHT = 30;
const ROW_GAP = 8;
const LABEL_WIDTH = 64;
const TOP_N = 10;

/**
 * Ranks the stations with the biggest overdue backlog — the one number on
 * this page that's actually actionable (send help there first). Single
 * series, so it stays the one hue the trend chart already uses for
 * "overdue" (var(--red)) rather than a new categorical palette; a station
 * is a bar, not a series, so no legend is needed beyond the title.
 */
export function EddNetworkChart({ stations }: { stations: EddNetworkStation[] }) {
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
    .filter((row) => row.buckets.overdue > 0)
    .sort((a, b) => b.buckets.overdue - a.buckets.overdue)
    .slice(0, TOP_N);

  if (!ranked.length) {
    return <p className="subtle">No overdue backlog at any tracked station right now.</p>;
  }

  const maxValue = Math.max(...ranked.map((row) => row.buckets.overdue));
  const plotWidth = Math.max(120, containerWidth - LABEL_WIDTH - 56);
  const height = ranked.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP;

  return (
    <div className="edd-network-chart" ref={containerRef}>
      <svg width="100%" height={height} role="img" aria-label="Top stations by overdue tracking IDs">
        {ranked.map((row, index) => {
          const barWidth = Math.max(3, (row.buckets.overdue / maxValue) * plotWidth);
          const y = index * (ROW_HEIGHT + ROW_GAP);
          const isHovered = hovered === row.stationCode;
          return (
            <g
              key={row.stationCode}
              className="edd-network-chart-row"
              onMouseEnter={() => setHovered(row.stationCode)}
              onMouseLeave={() => setHovered((current) => (current === row.stationCode ? null : current))}
              onClick={() => router.push(`/edd/${encodeURIComponent(row.stationCode)}`)}
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
                className={`edd-network-chart-bar${isHovered ? " hovered" : ""}`}
              />
              <text x={LABEL_WIDTH + barWidth + 8} y={y + ROW_HEIGHT / 2 + 4} className="edd-network-chart-value">
                {row.buckets.overdue.toLocaleString("en-IN")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
