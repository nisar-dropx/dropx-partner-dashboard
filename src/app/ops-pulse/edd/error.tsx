"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function EddNetworkError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("EDD network page crashed:", error);
  }, [error]);

  return (
    <div className="ops-command-center">
      <section className="panel message-panel error">
        <div className="panel-body" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={20} style={{ flex: "none", marginTop: 2, color: "var(--red)" }} />
          <div>
            <strong>Delivery Performance hit an error</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              Something went wrong loading the network overview. This is usually transient — try again.
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
