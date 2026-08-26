"use client";

import { useState } from "react";
import { Clock, TrendingUp } from "lucide-react";
import type { EddNetworkRunStatus, EddNetworkStation } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "./page";
import { EddNetworkClient } from "./edd-network-client";
import { EddNetworkPerformanceView } from "./edd-network-performance-view";

type EddNetworkView = "ageing" | "performance";

export function EddNetworkTabs({
  stations,
  initialNetwork,
  initialRun
}: {
  stations: EddStationOption[];
  initialNetwork: EddNetworkStation[];
  initialRun: EddNetworkRunStatus | null;
}) {
  const [view, setView] = useState<EddNetworkView>("ageing");

  return (
    <>
      <section className="panel">
        <div className="panel-body" style={{ display: "flex", justifyContent: "flex-start" }}>
          <div className="edd-view-toggle" role="tablist" aria-label="How to view the network">
            <button
              type="button"
              role="tab"
              aria-selected={view === "ageing"}
              className={`edd-view-tab${view === "ageing" ? " active" : ""}`}
              onClick={() => setView("ageing")}
            >
              <Clock size={16} aria-hidden /> Ageing
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "performance"}
              className={`edd-view-tab${view === "performance" ? " active" : ""}`}
              onClick={() => setView("performance")}
            >
              <TrendingUp size={16} aria-hidden /> Performance
            </button>
          </div>
        </div>
      </section>

      {view === "ageing" ? (
        <EddNetworkClient stations={stations} initialNetwork={initialNetwork} initialRun={initialRun} />
      ) : (
        <EddNetworkPerformanceView stations={stations} />
      )}
    </>
  );
}
