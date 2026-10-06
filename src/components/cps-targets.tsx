"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCpsTarget } from "@/app/cps/actions";

export type CpsTargetRevision = {
  id: string; station_code: string; target_cps: number;
  effective_from: string; is_active: boolean;
};
export function CpsTargets({targets, stations, today, canAdd}: {
  targets: CpsTargetRevision[]; stations: string[]; today: string; canAdd: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
      <section className="panel">
        <div className="panel-head">
          <h2>CPS targets</h2>
        </div>
        <div className="panel-body">
          {canAdd && (
            <form
              className="cps-input-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                try {
                  const result = await saveCpsTarget(
                    new FormData(event.currentTarget),
                  );
                  setMessage(result.message);
                  if (result.ok) router.refresh();
                } catch {
                  setMessage(
                    "Save could not be confirmed. Refresh before retrying.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Parent / standalone station
                <select name="station_code" required defaultValue="">
                  <option value="" disabled>Select station</option>
                  {stations.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Target CPS ₹
                <input
                  name="target_cps"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  required
                />
              </label>
              <label>
                Effective from
                <input
                  name="effective_from"
                  type="date"
                  required
                  defaultValue={today}
                />
              </label>
              <button disabled={busy || !stations.length} className="button primary">
                {busy ? "Saving…" : "Add target revision"}
              </button>
              <p role="status">{message}</p>
            </form>
          )}
          <p>
            Set the total target per delivered shipment. A parent station’s target includes its mapped XPTs in OpsPulse and DropX One.
            Add a dated revision to change a target without overwriting earlier periods. When a period spans revisions, targets are weighted by delivered shipments.
          </p>
          <div className="cps-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Target CPS</th>
                  <th>Effective from</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td>{t.station_code}</td>
                    <td>₹{Number(t.target_cps).toFixed(2)}</td>
                    <td>{t.effective_from}</td>
                    <td>{t.is_active ? "Active" : "Disabled"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!targets.length && <p>No station targets configured.</p>}
        </div>
      </section>
  );
}
