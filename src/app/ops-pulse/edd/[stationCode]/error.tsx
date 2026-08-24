"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";

export default function EddStationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("EDD station page crashed:", error);
  }, [error]);

  return (
    <div className="ops-command-center">
      <Link className="edd-back-link" href="/edd" prefetch={false}>
        <ArrowLeft size={14} /> All stations
      </Link>
      <section className="panel message-panel error">
        <div className="panel-body" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={20} style={{ flex: "none", marginTop: 2, color: "var(--red)" }} />
          <div>
            <strong>This station's page hit an error</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              Something went wrong rendering this station's live data. This is usually transient — try again, or go
              back and reopen the station.
            </p>
            <button
              type="button"
              className="button secondary"
              onClick={() => reset()}
              style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
