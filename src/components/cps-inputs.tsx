"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCpsCost, saveCpsTarget } from "@/app/cps/actions";
import { cpsHeads, type CpsCostInput } from "@/lib/ops-pulse/cps";

function CostForm({
  record,
  stations,
  today,
  employees,
}: {
  employees: {id:string;label:string}[];
  record?: CpsCostInput;
  stations: string[];
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [employee, setEmployee] = useState(record?.employee_id || "");
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
      <label>Cost source
        <select name="employee_id" value={employee} onChange={e=>setEmployee(e.target.value)}>
          <option value="">Manual expense / adjustment</option>
          {employees.map(e=><option key={e.id} value={e.id}>People CTC · {e.label}</option>)}
        </select>
      </label>
      {employee && <p className="cps-form-note">Uses the employee’s effective CTC from People and replaces their automatic allocation. Salary revisions flow through automatically.</p>}
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
      <label>Breakup
        <input name="sub_head" defaultValue={record?.sub_head || record?.label} list="cps-breakups" placeholder="Choose or type a cost breakup" maxLength={120}/>
      </label>
      <label>
        {employee ? 'Amount from People CTC' : 'Amount ₹'}
        <input
          name="amount"
          required
          type="number"
          min="0"
          step="0.01"
          key={employee}
          defaultValue={employee ? 0 : record?.amount}
          readOnly={Boolean(employee)}
        />
      </label>
      <label>
        Frequency
        <select name="frequency" defaultValue={record?.frequency || "monthly"}>
          <option value="monthly">Monthly, calendar-day accrual</option>
          {!employee && <option value="once">One-off on start date</option>}
        </select>
      </label>
      <label>
        Location codes
        <input
          name="station_codes"
          required
          defaultValue={record?.station_codes.join(", ")}
          list={record ? `cps-locations-${record.id}` : "cps-location-codes"}
          placeholder="KOZA, KGQA"
        />
        <datalist id={record ? `cps-locations-${record.id}` : "cps-location-codes"}>
          {stations.map((s) => <option key={s}>{s}</option>)}
        </datalist>
      </label>
      <label>
        Shared-cost allocation
        <select name="allocation" defaultValue={record?.allocation || "equal"}>
          <option value="equal">Equal share</option>
          <option value="delivery_share">Daily delivered-volume share</option>
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
  employees,
}: {
  employees: {id:string;label:string}[];
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
      <datalist id="cps-breakups">{['Company vehicle rent','Dock van rent','Van fuel','Van driver pay','Van maintenance','Vehicle insurance / permits','DA salary','DA variable pay','DA fuel','Facility rent','Electricity','Internet','Repairs and supplies','Cluster manager CTC','AOM CTC','Telecaller CTC','Shared overhead'].map(label=><option key={label}>{label}</option>)}</datalist>
      <section className="panel">
        <div className="panel-head">
          <h2>Cost sources</h2>
        </div>
        <div className="panel-body">
          <p>
            DA costs recalculate from DropX workforce identities, current effective rate cards and daily shipment counts. Fuel imports,
            Cashbook and approved Adhoc requests update CPS automatically.
            Station rent and maintenance accrue from Finance Rent Master.
          </p>
          <p>
            People CTC supplies station staff and shared manager costs automatically. Add van rent, dock van rent, maintenance, electricity and other costs here when they are not recorded elsewhere. Choose a People employee to customize their cost head and station allocation. Monthly costs use calendar days.
          </p>
          <p>
            Changing the location filter does not change a shared cost’s
            allocation. Shared costs use that day’s deliveries across the full allocation group. Zero-volume groups split equally. Corrected workforce mappings immediately refresh CPS.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Cost register and People allocations</h2>
        </div>
        <div className="panel-body">
          {canAdd && (
            <details className="cps-input-detail">
              <summary>Add cost</summary>
              <CostForm stations={stations} today={today} employees={employees} />
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
                <CostForm record={c} stations={stations} today={today} employees={employees} />
              ) : (
                <p>
                  Read-only. Contact the CPS input owner to change this cost.
                </p>
              )}
            </details>
          ))}
          {!costs.length && (
            <p>
              No manual costs or People allocation overrides in this scope. Automatic People CTC, workforce payouts and Finance rent are included when configured.
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
