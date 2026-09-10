"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { csvText, todayIndia } from "@/lib/finance/pricing";
import {
  monthlyRentTotal,
  rentPeriodStatus,
  type RentInput,
  type RentRecord,
} from "@/lib/finance/rent";
import { deleteRent, saveRent } from "./actions";

type Location = { code: string; name: string; region: string; parent: string | null };

function download(filename: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="fin-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="fin-dialog-head">
        <h2>{title}</h2>
        <button className="button secondary" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

const money = (value: string) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function blank(today: string): RentInput {
  return {
    id: null,
    site_code: "",
    allocation_station_code: "",
    parent_station_code: null,
    region: null,
    payee_name: "",
    monthly_rent: "",
    monthly_maintenance: "0",
    effective_from: `${today.slice(0, 7)}-01`,
    effective_to: null,
    change_reason: "New rent agreement",
    expected_updated_at: null,
  };
}

export function RentManager({
  records,
  locations,
  canAdd,
  canEdit,
}: {
  records: RentRecord[];
  locations: Location[];
  canAdd: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const today = todayIndia();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Active");
  const [editing, setEditing] = useState<RentInput | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const active = records.filter((record) => rentPeriodStatus(record, today) === "Active");
  const filtered = useMemo(
    () =>
      records.filter((record) => {
        const current = rentPeriodStatus(record, today);
        return (
          (status === "All" || current === status) &&
          `${record.site_code} ${record.allocation_station_code} ${record.payee_name} ${record.region || ""}`
            .toLowerCase()
            .includes(search.trim().toLowerCase())
        );
      }),
    [records, search, status, today],
  );
  const activeMonthly = active.reduce(
    (sum, record) => sum + Number(monthlyRentTotal(record)),
    0,
  );
  const activeAllocations = new Set(active.map((record) => record.allocation_station_code)).size;

  const edit = (record: RentRecord) => {
    setError("");
    setEditing({
      id: record.id,
      site_code: record.site_code,
      allocation_station_code: record.allocation_station_code,
      parent_station_code: record.parent_station_code,
      region: record.region,
      payee_name: record.payee_name,
      monthly_rent: record.monthly_rent,
      monthly_maintenance: record.monthly_maintenance,
      effective_from: record.effective_from,
      effective_to: record.effective_to,
      change_reason: "Updated rent agreement",
      expected_updated_at: record.updated_at,
    });
  };
  const update = (key: keyof RentInput, value: string | null) =>
    setEditing((current) => (current ? { ...current, [key]: value } : current));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing || pending) return;
    setError("");
    setPending(true);
    try {
      const result = await saveRent(editing);
      if (!result.ok) return setError(result.error);
      setEditing(null);
      setNotice(editing.id ? "Rent agreement updated." : "Rent agreement added.");
      router.refresh();
    } catch {
      setError("The connection was interrupted. Refresh and review before retrying.");
    } finally {
      setPending(false);
    }
  }

  async function remove(record: RentRecord) {
    if (pending || !window.confirm(`Delete the rent agreement for ${record.site_code} · ${record.payee_name}?`)) return;
    setError("");
    setPending(true);
    try {
      const result = await deleteRent({ id: record.id, expected_updated_at: record.updated_at });
      if (!result.ok) return setError(result.error);
      setNotice("Rent agreement deleted. Its audit history is retained.");
      router.refresh();
    } catch {
      setError("The connection was interrupted. Refresh and review before retrying.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section className="summary-grid">
        <div className="metric-card">
          <span>Active agreements</span>
          <strong>{active.length}</strong>
          <small>Closing and closed source rows are excluded</small>
        </div>
        <div className="metric-card">
          <span>Active monthly commitment</span>
          <strong>{money(String(activeMonthly))}</strong>
          <small>Rent plus maintenance</small>
        </div>
        <div className="metric-card">
          <span>Cost allocations</span>
          <strong>{activeAllocations}</strong>
          <small>Active Finance locations</small>
        </div>
        <div className="metric-card">
          <span>Calculation</span>
          <strong>Calendar days</strong>
          <small>28, 29, 30 or 31 days for the selected month</small>
        </div>
      </section>

      <div className="fin-toolbar">
        <div>
          <span className="fin-chip">Effective dated</span>{" "}
          <span className="fin-chip">Audit history retained</span>{" "}
          <span className="fin-chip">P&L connected</span>
        </div>
        <div className="fin-actions">
          <button
            className="button secondary"
            type="button"
            disabled={!filtered.length}
            onClick={() =>
              download(
                `rent-master-${today}.csv`,
                csvText([
                  ["Site", "Cost allocation", "Parent", "Region", "Payee", "Monthly rent", "Monthly maintenance", "Monthly total", "Effective from", "Effective through", "Status", "Source", "Source row", "Last updated"],
                  ...filtered.map((record) => [record.site_code, record.allocation_station_code, record.parent_station_code, record.region, record.payee_name, record.monthly_rent, record.monthly_maintenance, monthlyRentTotal(record), record.effective_from, record.effective_to, rentPeriodStatus(record, today), record.source_file, record.source_row, record.updated_at]),
                ]),
              )
            }
          >
            Download CSV
          </button>
          {canAdd && (
            <button className="button" type="button" onClick={() => { setError(""); setEditing(blank(today)); }}>
              Add rent agreement
            </button>
          )}
        </div>
      </div>

      {notice && <div className="fin-notice success" role="status">{notice}</div>}
      {error && <div className="fin-notice error" role="alert">{error}</div>}

      <div className="fin-filters">
        <label>
          Agreement status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option>Active</option>
            <option>Upcoming</option>
            <option>Ended</option>
            <option>All</option>
          </select>
        </label>
        <label>
          Search rent master
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Site, allocation, payee or region" />
        </label>
        <span className="subtle">{filtered.length} agreements</span>
      </div>

      <div className="fin-notice">
        The site code identifies the rented premise. Cost allocation controls where the amount appears in Finance P&amp;L. Each month is divided by its actual calendar days; active daily amounts reconcile exactly to the displayed monthly commitment.
      </div>

      <section className="panel">
        <div className="fin-table-wrap">
          <table className="fin-table">
            <thead>
              <tr>
                <th>Premise / allocation</th>
                <th>Payee</th>
                <th>Monthly rent</th>
                <th>Maintenance</th>
                <th>Monthly total</th>
                <th>Effective period</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.site_code}</strong>
                    <small>Allocated to {record.allocation_station_code}{record.parent_station_code ? ` · parent ${record.parent_station_code}` : ""}</small>
                    <small>{record.region || "Region not supplied"}</small>
                  </td>
                  <td><strong>{record.payee_name}</strong></td>
                  <td>{money(record.monthly_rent)}</td>
                  <td>{money(record.monthly_maintenance)}</td>
                  <td><strong>{money(monthlyRentTotal(record))}</strong></td>
                  <td>
                    <span className={`fin-chip ${rentPeriodStatus(record, today) === "Ended" ? "warning" : ""}`}>{rentPeriodStatus(record, today)}</span>
                    <small>{record.effective_from} → {record.effective_to || "Ongoing"}</small>
                  </td>
                  <td>
                    {record.source_file || "Manual entry"}
                    <small>{record.source_sheet ? `${record.source_sheet}${record.source_row ? ` · row ${record.source_row}` : ""}` : `Updated ${record.updated_at.slice(0, 10)}`}</small>
                  </td>
                  <td>
                    <div className="fin-actions">
                      {canEdit && <button className="button secondary small" type="button" onClick={() => edit(record)}>Edit</button>}
                      {canEdit && <button className="button ghost small" type="button" disabled={pending} onClick={() => remove(record)}>Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={8} className="fin-empty">No rent agreements match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <Modal title={editing.id ? `Edit rent · ${editing.site_code}` : "Add rent agreement"} onClose={() => !pending && setEditing(null)}>
          <form onSubmit={submit}>
            <div className="fin-form-grid">
              <label>
                Premise / site code
                <input required maxLength={40} value={editing.site_code} onChange={(event) => update("site_code", event.target.value.toUpperCase())} placeholder="Example: SBPD-BURLA" />
              </label>
              <label>
                Cost allocation
                <select
                  required
                  value={editing.allocation_station_code}
                  onChange={(event) => {
                    const location = locations.find((item) => item.code === event.target.value);
                    setEditing((current) => current ? { ...current, allocation_station_code: event.target.value, region: location?.region || current.region, parent_station_code: location?.parent || current.parent_station_code } : current);
                  }}
                >
                  <option value="">Choose an active location</option>
                  {locations.map((location) => <option key={location.code} value={location.code}>{location.code} · {location.name}</option>)}
                </select>
              </label>
              <label>
                Parent station (optional)
                <input maxLength={40} value={editing.parent_station_code || ""} onChange={(event) => update("parent_station_code", event.target.value.toUpperCase() || null)} />
              </label>
              <label>
                Region
                <input maxLength={100} value={editing.region || ""} onChange={(event) => update("region", event.target.value)} />
              </label>
              <label>
                Payee / landlord
                <input required maxLength={160} value={editing.payee_name} onChange={(event) => update("payee_name", event.target.value)} />
              </label>
              <label>
                Monthly rent (₹)
                <input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={editing.monthly_rent} onChange={(event) => update("monthly_rent", event.target.value)} />
              </label>
              <label>
                Monthly maintenance (₹)
                <input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={editing.monthly_maintenance} onChange={(event) => update("monthly_maintenance", event.target.value)} />
              </label>
              <label>
                Effective from
                <input required type="date" value={editing.effective_from} onChange={(event) => update("effective_from", event.target.value)} />
              </label>
              <label>
                Effective through (optional)
                <input type="date" min={editing.effective_from} value={editing.effective_to || ""} onChange={(event) => update("effective_to", event.target.value || null)} />
              </label>
            </div>
            <label className="fin-label">
              Change reason
              <textarea required maxLength={500} value={editing.change_reason} onChange={(event) => update("change_reason", event.target.value)} />
            </label>
            {error && <div className="fin-notice error" role="alert">{error}</div>}
            <div className="fin-dialog-footer">
              <button className="button secondary" type="button" disabled={pending} onClick={() => setEditing(null)}>Cancel</button>
              <button className="button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save rent agreement"}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
