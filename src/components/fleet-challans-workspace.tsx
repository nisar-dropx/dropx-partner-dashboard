"use client";

import { AlertTriangle, Check, ExternalLink, FileWarning, Plus, ReceiptIndianRupee, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import { FleetMobileSection } from "@/components/fleet-mobile-section";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import { FleetVehicleMeta } from "@/components/fleet-vehicle-meta";
import { SearchableSelect } from "@/components/searchable-select";
import type { FleetControlData, FleetControlVehicle } from "@/lib/fleet-control";

type ChallanStatus =
  | "pending_review"
  | "disputed"
  | "approved_for_recovery"
  | "recovering"
  | "recovered"
  | "disposed"
  | "cancelled"
  | "paid_external";

type FleetChallan = {
  id: string;
  vehicleNo: string;
  stationCode: string;
  stateCode: string;
  challanNumber: string;
  offenseDate: string | null;
  offenseDescription: string;
  issuingAuthority: string;
  amount: number;
  status: ChallanStatus;
  source: string;
  evidenceUrl: string;
  driveViewUrl: string;
  responsibleNote: string;
  recoveryMonth: string | null;
  recoveryCaseKey: string | null;
  createdAt: string;
};

type ChallanEvent = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string;
  note: string;
  createdAt: string;
};

const statusLabel: Record<ChallanStatus, string> = {
  pending_review: "Pending review",
  disputed: "Disputed",
  approved_for_recovery: "Approved for recovery",
  recovering: "Recovering",
  recovered: "Recovered",
  disposed: "Disposed",
  cancelled: "Cancelled",
  paid_external: "Paid outside DropX"
};

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const day = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(parsed);
};

function recoveryHref(challan: FleetChallan) {
  if (!challan.recoveryMonth || !challan.recoveryCaseKey) return "/ops-pulse/team-ops/losses/recovery-updates";
  return `/ops-pulse/team-ops/losses/recovery-updates?month=${encodeURIComponent(challan.recoveryMonth)}&case=${encodeURIComponent(challan.recoveryCaseKey)}`;
}

export function FleetChallansWorkspace({
  data,
  vehicles
}: {
  data: FleetControlData;
  vehicles: FleetControlVehicle[];
}) {
  const [challans, setChallans] = useState<FleetChallan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [canAdd, setCanAdd] = useState(false);
  const [driveConfigured, setDriveConfigured] = useState(false);
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>(["pending_review", "disputed", "approved_for_recovery", "recovering"]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ challan: FleetChallan; events: ChallanEvent[]; recoveryHref: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState("");
  const [form, setForm] = useState({
    vehicleNo: "",
    challanNumber: "",
    amount: "",
    offenseDate: data.today,
    offenseDescription: "",
    issuingAuthority: "mvd",
    evidenceUrl: ""
  });
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/fleet/challans", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load challans.");
      setChallans(payload.challans || []);
      setCanEdit(Boolean(payload.canEdit));
      setCanAdd(Boolean(payload.canAdd));
      setDriveConfigured(Boolean(payload.driveConfigured));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load challans.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    fetch(`/api/fleet/challans/${selectedId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to open challan.");
        setDetail({ challan: payload.challan, events: payload.events || [], recoveryHref: payload.recoveryHref });
        setNote(payload.challan.responsibleNote || "");
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message || "Unable to open challan.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  const ownedVehicles = useMemo(
    () => vehicles.filter((vehicle) => (vehicle.ownershipType || "own").toLowerCase() === "own"),
    [vehicles]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return challans
      .filter((row) => (!stations.length || stations.includes(row.stationCode))
        && (!statuses.length || statuses.includes(row.status))
        && (!needle || `${row.vehicleNo} ${row.stationCode} ${row.challanNumber} ${row.offenseDescription}`.toLowerCase().includes(needle)))
      .sort((a, b) => (b.offenseDate || b.createdAt).localeCompare(a.offenseDate || a.createdAt));
  }, [challans, query, stations, statuses]);

  const outstanding = useMemo(
    () => challans.filter((row) => ["pending_review", "disputed", "approved_for_recovery", "recovering"].includes(row.status)),
    [challans]
  );

  async function createChallan(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      Object.entries(form).forEach(([key, value]) => body.set(key, value));
      if (evidenceFile) body.set("evidence", evidenceFile);
      const response = await fetch("/api/fleet/challans", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save challan.");
      setCreating(false);
      setEvidenceFile(null);
      setForm({ vehicleNo: "", challanNumber: "", amount: "", offenseDate: data.today, offenseDescription: "", issuingAuthority: "mvd", evidenceUrl: "" });
      setNotice(`Challan ${payload.challan.challanNumber} recorded for ${payload.challan.vehicleNo}.`);
      await loadList();
      setSelectedId(payload.challan.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save challan.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: ChallanStatus) {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/fleet/challans/${selectedId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to update status.");
      setNotice(`Status updated to ${statusLabel[payload.challan.status as ChallanStatus]}.`);
      await loadList();
      setSelectedId(payload.challan.id);
      setDetail((current) => current ? { ...current, challan: payload.challan } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update status.");
    } finally {
      setBusy(false);
    }
  }

  async function openRecovery() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/fleet/challans/${selectedId}/open-recovery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to open recovery.");
      setNotice("Recovery case opened in Team Ops. Assign associates/UTRs and split installments there.");
      await loadList();
      setDetail((current) => current ? { ...current, challan: payload.challan, recoveryHref: payload.recoveryHref } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open recovery.");
    } finally {
      setBusy(false);
    }
  }

  const report = {
    title: "Fleet challans",
    subtitle: `${data.today} · outstanding and reviewed traffic fines`,
    fileName: `fleet-challans-${data.today}`,
    headers: ["Challan", "Vehicle", "Station", "Offense date", "Amount", "Status", "Violation", "Authority", "Evidence"],
    rows: filtered.map((row) => [
      row.challanNumber,
      row.vehicleNo,
      row.stationCode,
      row.offenseDate || "",
      row.amount,
      statusLabel[row.status],
      row.offenseDescription,
      row.issuingAuthority,
      row.driveViewUrl || row.evidenceUrl || ""
    ])
  };

  return (
    <section className="fc-section">
      <div className="fc-section-head">
        <div>
          <span className="fc-eyebrow">Fleet compliance</span>
          <h1>Challans</h1>
          <p>Review outstanding e-challans, store evidence in Google Drive, and recover through the existing Team Ops NL/SLP ledger.</p>
        </div>
        <div className="fc-hero-actions">
          <FleetExportButtons report={report} />
          {canAdd ? (
            <button className="fc-button primary" type="button" onClick={() => setCreating(true)}>
              <Plus size={16} /> Record challan
            </button>
          ) : null}
        </div>
      </div>

      <div className="fc-segment-cards fc-registry-stats">
        <article><small>Outstanding</small><strong>{outstanding.length}</strong></article>
        <article><small>Outstanding amount</small><strong>{money(outstanding.reduce((sum, row) => sum + row.amount, 0))}</strong></article>
        <article><small>Pending review</small><strong>{challans.filter((row) => row.status === "pending_review").length}</strong></article>
        <article><small>In recovery</small><strong>{challans.filter((row) => ["approved_for_recovery", "recovering"].includes(row.status)).length}</strong></article>
      </div>

      {!driveConfigured ? (
        <div className="fc-flash notice" role="status">
          <span>
            <FileWarning size={17} />
            Google Drive folder is not configured yet. Set `FLEET_CHALLAN_DRIVE_FOLDER_ID` (or reuse `MARSH_DRIVE_FOLDER_ID`) with `GOOGLE_OAUTH_*`. HTTPS evidence links still work.
          </span>
        </div>
      ) : null}

      {notice ? (
        <div className="fc-flash notice" role="status">
          <span><Check size={17} />{notice}</span>
          <button aria-label="Dismiss" type="button" onClick={() => setNotice("")}><X size={16} /></button>
        </div>
      ) : null}
      {error ? <div className="fc-flash error" role="alert"><span><AlertTriangle size={17} />{error}</span></div> : null}

      <FleetMobileSection title="Filters" summary={`${filtered.length} challans`} className="fc-mobile-filters">
        <div className="fc-exception-controls">
          <label>
            Search
            <span className="fc-search-wrap"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Vehicle, challan, station, violation" /></span>
          </label>
          <FleetMultiSelect
            allLabel="All stations"
            label="Station"
            onChange={setStations}
            options={[...new Set(challans.map((row) => row.stationCode))].sort().map((code) => ({ value: code, label: code }))}
            values={stations}
          />
          <FleetMultiSelect
            allLabel="All statuses"
            label="Status"
            onChange={setStatuses}
            options={(Object.keys(statusLabel) as ChallanStatus[]).map((value) => ({ value, label: statusLabel[value] }))}
            values={statuses}
          />
        </div>
      </FleetMobileSection>

      <div className="fc-table-panel">
        <div className="fc-table-toolbar"><span>{loading ? "Loading…" : `${filtered.length} challans`}</span></div>
        <div className="fc-table-scroll">
          <table className="fc-table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Station</th>
                <th>Challan</th>
                <th>Offense</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.vehicleNo}</strong>
                    <FleetVehicleMeta vehicleNo={row.vehicleNo} stationCode={row.stationCode} />
                  </td>
                  <td>{row.stationCode}</td>
                  <td>
                    <strong>{row.challanNumber}</strong>
                    <small>{row.issuingAuthority.replaceAll("_", " ")}</small>
                  </td>
                  <td>
                    <strong>{day(row.offenseDate)}</strong>
                    <small>{row.offenseDescription || "Traffic challan"}</small>
                  </td>
                  <td><strong>{money(row.amount)}</strong></td>
                  <td><span className={`fc-status-pill ${row.status}`}>{statusLabel[row.status]}</span></td>
                  <td>
                    <button className="fc-button secondary" type="button" onClick={() => setSelectedId(row.id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !filtered.length ? (
            <div className="fc-empty">
              <ReceiptIndianRupee size={28} />
              <strong>No challans match these filters</strong>
              <p>Record a challan manually, or wait for an authorized provider/ingest feed.</p>
            </div>
          ) : null}
        </div>
      </div>

      {creating ? (
        <div className="fc-modal-backdrop">
          <section className="fc-modal" role="dialog" aria-modal="true" aria-labelledby="create-challan-title">
            <button className="fc-modal-close" type="button" disabled={busy} onClick={() => setCreating(false)} aria-label="Close"><X size={20} /></button>
            <div className="fc-modal-title">
              <span className="fc-vehicle-big"><Plus size={22} /></span>
              <div>
                <small>Manual entry</small>
                <h2 id="create-challan-title">Record challan</h2>
                <p>Owned vehicles only. Evidence uploads stream to Google Drive when configured.</p>
              </div>
            </div>
            <form className="fc-exception-review-form" onSubmit={createChallan}>
              <label>
                Vehicle
                <SearchableSelect
                  name="vehicleNo"
                  value={form.vehicleNo}
                  onValueChange={(value) => setForm((current) => ({ ...current, vehicleNo: value }))}
                  options={ownedVehicles.map((vehicle) => ({ value: vehicle.vehicleNo, label: `${vehicle.vehicleNo} · ${vehicle.stationCode}` }))}
                  placeholder="Select owned vehicle"
                  required
                />
              </label>
              <label>Challan number<input required value={form.challanNumber} onChange={(event) => setForm((current) => ({ ...current, challanNumber: event.target.value }))} /></label>
              <label>Amount (₹)<input required type="number" min="0" step="0.01" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} /></label>
              <label>Offense date<input type="date" value={form.offenseDate} onChange={(event) => setForm((current) => ({ ...current, offenseDate: event.target.value }))} /></label>
              <label>
                Issuing authority
                <select value={form.issuingAuthority} onChange={(event) => setForm((current) => ({ ...current, issuingAuthority: event.target.value }))}>
                  <option value="mvd">MVD</option>
                  <option value="traffic_police">Traffic police</option>
                  <option value="virtual_court">Virtual court</option>
                  <option value="parivahan">Parivahan</option>
                  <option value="other">Other</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>
              <label>Violation details<textarea required maxLength={2000} rows={3} value={form.offenseDescription} onChange={(event) => setForm((current) => ({ ...current, offenseDescription: event.target.value }))} /></label>
              <label>Evidence URL (https)<input type="url" value={form.evidenceUrl} onChange={(event) => setForm((current) => ({ ...current, evidenceUrl: event.target.value }))} placeholder="https://…" /></label>
              <label>Or upload evidence file<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setEvidenceFile(event.target.files?.[0] || null)} /></label>
              <div className="fc-form-actions">
                <button className="fc-button secondary" type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
                <button className="fc-button primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save challan"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {selectedId ? (
        <div className="fc-modal-backdrop">
          <section className="fc-modal wide" role="dialog" aria-modal="true" aria-labelledby="challan-detail-title">
            <button className="fc-modal-close" type="button" disabled={busy} onClick={() => setSelectedId(null)} aria-label="Close"><X size={20} /></button>
            {detailLoading || !detail ? (
              <p role="status">Loading challan…</p>
            ) : (
              <>
                <div className="fc-modal-title">
                  <span className="fc-vehicle-big"><ReceiptIndianRupee size={22} /></span>
                  <div>
                    <small>{detail.challan.stationCode} · {detail.challan.stateCode || "IN"}</small>
                    <h2 id="challan-detail-title">{detail.challan.challanNumber}</h2>
                    <FleetVehicleMeta vehicleNo={detail.challan.vehicleNo} stationCode={detail.challan.stationCode} />
                    <p>{statusLabel[detail.challan.status]} · {money(detail.challan.amount)}</p>
                  </div>
                </div>
                <div className="fc-route-summary">
                  <div><small>Offense date</small><strong>{day(detail.challan.offenseDate)}</strong></div>
                  <div><small>Authority</small><strong>{detail.challan.issuingAuthority.replaceAll("_", " ")}</strong></div>
                  <div><small>Source</small><strong>{detail.challan.source}</strong></div>
                </div>
                <p>{detail.challan.offenseDescription || "No violation detail recorded."}</p>
                {(detail.challan.driveViewUrl || detail.challan.evidenceUrl) ? (
                  <p>
                    <a href={detail.challan.driveViewUrl || detail.challan.evidenceUrl} target="_blank" rel="noreferrer">
                      Open evidence <ExternalLink size={14} />
                    </a>
                  </p>
                ) : (
                  <p className="fc-exception-timing">No evidence file linked yet.</p>
                )}
                {canEdit ? (
                  <form className="fc-exception-review-form" onSubmit={(event) => event.preventDefault()}>
                    <label>
                      Review note / responsible associate
                      <textarea maxLength={2000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who should recover this, and any dispute notes." />
                    </label>
                    <div className="fc-form-actions" style={{ flexWrap: "wrap" }}>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => void setStatus("disputed")}>Mark disputed</button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => void setStatus("paid_external")}>Paid outside DropX</button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => void setStatus("disposed")}>Disposed / closed</button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => void setStatus("cancelled")}>Cancel</button>
                      <button className="fc-button primary" type="button" disabled={busy || detail.challan.amount <= 0} onClick={() => void openRecovery()}>
                        {detail.challan.recoveryCaseKey ? "Refresh recovery case" : "Approve & open recovery"}
                      </button>
                      {detail.challan.recoveryCaseKey ? (
                        <a className="fc-button secondary" href={detail.recoveryHref || recoveryHref(detail.challan)} target="_blank" rel="noreferrer">
                          Open Team Ops recovery <ExternalLink size={14} />
                        </a>
                      ) : null}
                    </div>
                  </form>
                ) : (
                  <p>Contact a Fleet editor to review or open recovery for this challan.</p>
                )}
                <h3>Activity</h3>
                <div className="fc-activity-list">
                  {detail.events.map((event) => (
                    <div key={event.id}>
                      <span>{day(event.createdAt)}</span>
                      <div>
                        <strong>{event.action}{event.toStatus ? ` → ${event.toStatus}` : ""}</strong>
                        <small>{event.actorName}{event.note ? ` · ${event.note}` : ""}</small>
                      </div>
                    </div>
                  ))}
                  {!detail.events.length ? <p>No events yet.</p> : null}
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
