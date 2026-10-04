"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CpsExpensePeriod } from "@/lib/ops-pulse/cps";
export function CpsBillPeriods({
  rows,
  canEdit,
  defaultOpen = false,
}: {
  rows: CpsExpensePeriod[];
  canEdit: boolean;
  defaultOpen?: boolean;
}) {
  const router = useRouter(),
    [edit, setEdit] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <details className="cps-drilldown" open={defaultOpen || undefined}>
      <summary>
        Billing periods{" "}
        <span>{rows.filter((r) => !r.confirmed).length} dates to confirm</span>
      </summary>
      <p className="cps-footnote">
        Monthly bills are spread over the full service period. When service
        dates are missing, the booking month is used and CPS remains
        provisional. Confirm the actual dates from the bill; no payment amount
        is changed.
      </p>
      <div className="cps-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Station / bill</th>
              <th>Bill total</th>
              <th>Service period</th>
              <th>Basis</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}:${r.source_id}`}>
                <td>
                  <strong>
                    {r.station_code} · {r.label}
                  </strong>
                  <small>
                    {r.source === "payment" ? "Request" : "Cashbook"}{" "}
                    {r.reference || r.source_id} · booked {r.booked_on}
                  </small>
                </td>
                <td>₹{r.amount.toLocaleString("en-IN")}</td>
                <td>
                  {r.period_from} – {r.period_to}
                </td>
                <td>
                  <span
                    className={r.confirmed ? "cps-confirmed" : "cps-missing"}
                  >
                    {r.confirmed ? "Confirmed" : "Booking month assumed"}
                  </span>
                </td>
                <td>
                  {canEdit && (
                    <button
                      className="button"
                      onClick={() => {
                        setEdit(`${r.source}:${r.source_id}`);
                        setError("");
                      }}
                    >
                      Set bill dates
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows
        .filter((r) => `${r.source}:${r.source_id}` === edit)
        .map((r) => (
          <form
            key={edit}
            className="cps-input-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const body = {
                kind: "period",
                source: r.source,
                source_id: r.source_id,
                ...Object.fromEntries(new FormData(e.currentTarget)),
              };
              setBusy(true);
              try {
                const res = await fetch("/api/ops-pulse/cps/settings", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                });
                const data = await res.json();
                if (!res.ok) throw Error(data.error);
                setEdit(null);
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Save failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <strong>
              {r.station_code} · {r.label}
            </strong>
            <label>
              Service from
              <input
                type="date"
                name="period_from"
                required
                defaultValue={r.period_from}
              />
            </label>
            <label>
              Service through
              <input
                type="date"
                name="period_to"
                required
                defaultValue={r.period_to}
              />
            </label>
            <label>
              Reason
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                placeholder="Dates verified against bill"
              />
            </label>
            <button disabled={busy} className="button primary">
              {busy ? "Saving…" : "Save billing period"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="button"
              onClick={() => setEdit(null)}
            >
              Cancel
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        ))}
    </details>
  );
}
