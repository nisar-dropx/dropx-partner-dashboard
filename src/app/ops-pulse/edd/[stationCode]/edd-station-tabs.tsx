"use client";

import { useState } from "react";
import { Clock, TrendingUp } from "lucide-react";
import { EddClient } from "./edd-client";
import { EddPerformanceView } from "./edd-performance-view";

type EddStationView = "ageing" | "performance";

export function EddStationTabs({ stationCode }: { stationCode: string }) {
  const [view, setView] = useState<EddStationView>("ageing");

  return (
    <>
      <section className="panel">
        <div className="panel-body" style={{ display: "flex", justifyContent: "flex-start" }}>
          <div className="edd-view-toggle" role="tablist" aria-label="How to view this station">
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

      {view === "ageing" ? <EddClient stationCode={stationCode} /> : <EddPerformanceView stationCode={stationCode} />}
    </>
  );
}
