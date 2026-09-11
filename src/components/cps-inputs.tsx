"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCpsCost, saveCpsTarget } from "@/app/cps/actions";
import { cpsHeads, type CpsCostInput } from "@/lib/ops-pulse/cps";

function CostForm({
  record,
  stations,
  today,
}: {
  record?: CpsCostInput;
  stations: string[];
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <form
      className="cps-input-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const result = await saveCpsCost(new FormData(event.currentTarget));
          setMessage(result.message);
          if (result.ok) router.refresh();
        } catch {
          setMessage("Save could not be confirmed. Refresh before retrying.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="hidden" name="id" value={record?.id || ""} />
      <input type="hidden" name="updated_at" value={record?.updated_at || ""} />
      <label>
        Cost name
        <input
          name="label"
          required
          maxLength={120}
          defaultValue={record?.label}
          placeholder="UTR staff, van rent, manager allocation…"
        />
      </label>
      <label>
        Head
        <select name="head" defaultValue={record?.head || "UTR"}>
          {cpsHeads.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </label>
      <label>
        Amount ₹
        <input
          name="amount"
          required
          type="number"
          min="0"
          step="0.01"
          defaultValue={record?.amount}
        />
      </label>
      <label>
        Frequency
        <select name="frequency" defaultValue={record?.frequency || "monthly"}>
          <option value="monthly">Monthly, calendar-day accrual</option>
          <option value="once">One-off on start date</option>
        </select>
      </label>
      <label>
        Location codes
        <input
          name="station_codes"
          required
          defaultValue={record?.station_codes.join(", ")}
          list="cps-location-codes"
          placeholder="KOZA, KGQA"
        />
        <datalist id={record ? undefined : "cps-location-codes"}>
          {!record && stations.map((s) => <option key={s}>{s}</option>)}
        </datalist>
      </label>
      <label>
        Shared-cost allocation
        <select name="allocation" defaultValue={record?.allocation || "equal"}>
          <option value="equal">Equal share</option>
          <option value="delivery_share">Month delivery share</option>
        </select>
      </label>
      <label>
        Effective from
        <input
          name="effective_from"
          type="date"
          required
          defaultValue={record?.effective_from || today}
        />
      </label>
      <label>
        Effective through
        <input
          name="effective_to"
          type="date"
          defaultValue={record?.effective_to || ""}
        />
      </label>
      <label>
        Status
        <select
          name="is_active"
          defaultValue={record?.is_active === false ? "false" : "true"}
        >
          <option value="true">Active</option>
          <option value="false">Disabled</option>
        </select>
      </label>
      <label>
        Note
        <input
          name="notes"
          maxLength={500}
          defaultValue={record?.notes || ""}
        />
      </label>
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Save cost"}
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
export function CpsInputs({
  costs,
  targets,
  stations,
  today,
  canAdd,
  canEdit,
}: {
  costs: CpsCostInput[];
  targets: {
    id: string;
    station_code: string;
    target_cps: number;
    effective_from: string;
    is_active: boolean;
  }[];
  stations: string[];
  today: string;
  canAdd: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="cps-inputs">
      <section className="panel">
        <div className="panel-head">
          <h2>Cost sources</h2>
        </div>
        <div className="panel-body">
          <p>
            Shipment payouts use the portal’s payment mappings. Fuel imports,
            Cashbook and approved Adhoc requests update CPS automatically.
            Station rent and maintenance accrue from Finance Rent Master.
          </p>
          <p>
            Add only costs not already recorded in these sources: fixed UTR
            staff, van rent, shared manager pay or other adjustments. Monthly
            amounts use actual calendar days. Shared manager costs can use
            monthly delivery share.
          </p>
          <p>
            Changing the location filter does not change a shared cost’s
            allocation. Payment setup gaps remain visible until the shipment
            payout source is corrected. No legacy Google Sheet data is silently
            copied over current records.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Fixed costs and adjustments</h2>
        </div>
        <div className="panel-body">
          {canAdd && (
            <details className="cps-input-detail">
              <summary>Add cost</summary>
              <CostForm stations={stations} today={today} />
            </details>
          )}
          {costs.map((c) => (
            <details className="cps-input-detail" key={c.id}>
              <summary>
                {c.label} · {c.head} · ₹
                {Number(c.amount).toLocaleString("en-IN")} · {c.frequency} ·{" "}
                {c.is_active ? "Active" : "Disabled"}
                <small>
                  {c.station_codes.join(", ")} · {c.effective_from} –{" "}
                  {c.effective_to || "ongoing"}
                </small>
              </summary>
              {canEdit ? (
                <CostForm record={c} stations={stations} today={today} />
              ) : (
                <p>
                  Read-only. Contact the CPS input owner to change this cost.
                </p>
              )}
            </details>
          ))}
          {!costs.length && (
            <p>
              No fixed cost inputs within this scope. Configure staff costs
              before treating CPS as complete.
            </p>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Station targets</h2>
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
                Location
                <select name="station_code">
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
              <button disabled={busy} className="button primary">
                {busy ? "Saving…" : "Add target revision"}
              </button>
              <p role="status">{message}</p>
            </form>
          )}
          <p>
            Targets are effective-dated. Add a new revision to change a target
            without overwriting earlier dates.
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
    </div>
  );
}
