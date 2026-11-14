"use client";

import {
  AlertTriangle,
  Building2,
  Check,
  Download,
  ExternalLink,
  FileWarning,
  Image as ImageIcon,
  Maximize2,
  Plus,
  ReceiptIndianRupee,
  Search,
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  driveFileId: string;
  driveViewUrl: string;
  driveMimeType: string;
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

// Issuing authority is stored as a coded enum; show a readable label.
// The Parivahan e-Challan system of record is run by the National Informatics Centre.
const authorityLabel: Record<string, string> = {
  parivahan: "National Informatics Centre · Parivahan e-Challan",
  mvd: "Motor Vehicles Dept (MVD)",
  traffic_police: "State Traffic Police",
  virtual_court: "Virtual Court",
  other: "Other authority",
  unknown: "Not recorded"
};
const authorityText = (code: string) => authorityLabel[code] || code.replaceAll("_", " ");

const sourceLabel: Record<string, string> = {
  portal_sync: "Parivahan portal sync",
  ingest: "Authorized ingest",
  manual: "Manual entry"
};
const sourceText = (code: string) => sourceLabel[code] || code.replaceAll("_", " ");

const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const day = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(parsed);
};

function recoveryHref(challan: FleetChallan) {
  if (!challan.recoveryMonth || !challan.recoveryCaseKey) return "/ops-pulse/team-ops/losses/challan-recovery";
  return `/ops-pulse/team-ops/losses/challan-recovery?month=${encodeURIComponent(challan.recoveryMonth)}&case=${encodeURIComponent(challan.recoveryCaseKey)}`;
}

// A pending action awaiting confirmation before it fires.
type PendingAction =
  | { kind: "status"; status: ChallanStatus }
  | { kind: "recovery" };

type ConfirmSpec = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone: "primary" | "danger" | "neutral";
  requireNote?: boolean;
};

function confirmSpecFor(action: PendingAction, challan: FleetChallan, hasRecoveryCase: boolean): ConfirmSpec {
  if (action.kind === "recovery") {
    return {
      title: hasRecoveryCase ? "Refresh recovery case?" : "Approve & open recovery?",
      body: (
        <>
          This files <strong>{money(challan.amount)}</strong> for <strong>{challan.vehicleNo}</strong> into the
          Team&nbsp;Ops NL/SLP recovery ledger for{" "}
          <strong>{challan.offenseDate ? day(challan.offenseDate) : "this month"}</strong>. You then assign the
          responsible associate/UTR and split installments there. Payroll shows this as a <em>planned</em> deduction
          until the salary month is processed.
        </>
      ),
      confirmLabel: hasRecoveryCase ? "Refresh case" : "Approve & open recovery",
      tone: "primary"
    };
  }
  const map: Record<ChallanStatus, ConfirmSpec> = {
    disputed: {
      title: "Mark as disputed?",
      body: <>Flag this challan as disputed. It stays outstanding and will not open recovery until re-reviewed.</>,
      confirmLabel: "Mark disputed",
      tone: "neutral",
      requireNote: true
    },
    paid_external: {
      title: "Mark paid outside DropX?",
      body: (
        <>
          Record that <strong>{money(challan.amount)}</strong> was already paid outside DropX. This closes the challan
          and <strong>no recovery</strong> will be raised against any associate.
        </>
      ),
      confirmLabel: "Confirm paid outside",
      tone: "neutral"
    },
    disposed: {
      title: "Dispose / close this challan?",
      body: <>Close this challan as disposed (e.g. settled at court or written off). It leaves the outstanding list.</>,
      confirmLabel: "Dispose / close",
      tone: "neutral"
    },
    cancelled: {
      title: "Cancel this challan?",
      body: (
        <>
          Cancel this challan (duplicate, wrong vehicle, or data error). It is removed from the outstanding list and no
          recovery is raised. This does not delete the record or its evidence.
        </>
      ),
      confirmLabel: "Cancel challan",
      tone: "danger"
    },
    pending_review: {
      title: "Return to pending review?",
      body: <>Move this challan back to pending review.</>,
      confirmLabel: "Return to review",
      tone: "neutral"
    },
    approved_for_recovery: { title: "", body: null, confirmLabel: "", tone: "primary" },
    recovering: { title: "", body: null, confirmLabel: "", tone: "primary" },
    recovered: { title: "", body: null, confirmLabel: "", tone: "primary" }
  };
  return map[action.status];
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
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [form, setForm] = useState({
    vehicleNo: "",
    challanNumber: "",
    amount: "",
    offenseDate: data.today,
    offenseDescription: "",
    issuingAuthority: "parivahan",
    evidenceUrl: ""
  });
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

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
    setEvidenceOpen(false);
    if (!selectedId) {
      setDetail(null);
      setPending(null);
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
      setForm({ vehicleNo: "", challanNumber: "", amount: "", offenseDate: data.today, offenseDescription: "", issuingAuthority: "parivahan", evidenceUrl: "" });
      setNotice(`Challan ${payload.challan.challanNumber} recorded for ${payload.challan.vehicleNo}.`);
      await loadList();
      setSelectedId(payload.challan.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save challan.");
    } finally {
      setBusy(false);
    }
  }

  async function runStatus(status: ChallanStatus) {
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

  async function runRecovery() {
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

  async function confirmPending() {
    if (!pending) return;
    const action = pending;
    setPending(null);
    if (action.kind === "recovery") await runRecovery();
    else await runStatus(action.status);
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
      authorityText(row.issuingAuthority),
      row.driveViewUrl || row.evidenceUrl || ""
    ])
  };

  const detailChallan = detail?.challan;
  const hasRecoveryCase = Boolean(detailChallan?.recoveryCaseKey);
  const confirmSpec = pending && detailChallan ? confirmSpecFor(pending, detailChallan, hasRecoveryCase) : null;
  const evidenceLink = detailChallan ? detailChallan.driveViewUrl || detailChallan.evidenceUrl : "";
  // The proxy streams the stored Drive file to any org member with Fleet access,
  // so it is preferred over the raw Drive/external link (which needs Drive sign-in).
  const evidenceProxy = detailChallan?.driveFileId ? `/api/fleet/challans/${detailChallan.id}/evidence` : "";
  const evidenceViewSrc = evidenceProxy || evidenceLink;
  const evidenceIsPdf = /pdf/i.test(detailChallan?.driveMimeType || "") || /\.pdf($|\?)/i.test(evidenceLink);

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

      <div className="fc-segment-cards fc-registry-stats fc-challan-stats">
        <article><small>Outstanding</small><strong>{outstanding.length}</strong></article>
        <article className="accent"><small>Outstanding amount</small><strong>{money(outstanding.reduce((sum, row) => sum + row.amount, 0))}</strong></article>
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
      {error ? <div className="fc-flash error" role="alert"><span><AlertTriangle size={17} />{error}</span><button aria-label="Dismiss" type="button" onClick={() => setError("")}><X size={16} /></button></div> : null}

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
          <table className="fc-table fc-challan-table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th>Station</th>
                <th>Challan</th>
                <th>Offense</th>
                <th>Amount</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className={selectedId === row.id ? "is-open" : undefined}>
                  <td>
                    <strong>{row.vehicleNo}</strong>
                    <FleetVehicleMeta vehicleNo={row.vehicleNo} stationCode={row.stationCode} />
                  </td>
                  <td>{row.stationCode}</td>
                  <td>
                    <strong className="fc-challan-no">{row.challanNumber}</strong>
                    <small>{authorityText(row.issuingAuthority)}</small>
                  </td>
                  <td>
                    <strong>{day(row.offenseDate)}</strong>
                    <small className="fc-clip">{row.offenseDescription || "Traffic challan"}</small>
                  </td>
                  <td><strong>{money(row.amount)}</strong></td>
                  <td><span className={`fc-status-pill st-${row.status}`}>{statusLabel[row.status]}</span></td>
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
              <p>Record a challan manually, or wait for the daily Parivahan sync.</p>
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
                  <option value="parivahan">NIC · Parivahan e-Challan</option>
                  <option value="mvd">MVD</option>
                  <option value="traffic_police">Traffic police</option>
                  <option value="virtual_court">Virtual court</option>
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
          <section className="fc-modal wide fc-challan-modal" role="dialog" aria-modal="true" aria-labelledby="challan-detail-title">
            <button className="fc-modal-close" type="button" disabled={busy} onClick={() => setSelectedId(null)} aria-label="Close"><X size={20} /></button>
            {detailLoading || !detail || !detailChallan ? (
              <p role="status" className="fc-challan-loading">Loading challan…</p>
            ) : (
              <>
                <header className="fc-challan-head">
                  <span className="fc-vehicle-big"><ReceiptIndianRupee size={22} /></span>
                  <div className="fc-challan-head-main">
                    <span className="fc-challan-head-tags">
                      <span className={`fc-status-pill st-${detailChallan.status}`}>{statusLabel[detailChallan.status]}</span>
                      <span className="fc-challan-state">{detailChallan.stationCode} · {detailChallan.stateCode || "IN"}</span>
                    </span>
                    <h2 id="challan-detail-title" className="fc-challan-no">{detailChallan.challanNumber}</h2>
                    <FleetVehicleMeta vehicleNo={detailChallan.vehicleNo} stationCode={detailChallan.stationCode} />
                  </div>
                  <div className="fc-challan-amount">
                    <small>Amount</small>
                    <strong>{money(detailChallan.amount)}</strong>
                  </div>
                </header>

                <div className="fc-challan-grid">
                  <div><span className="fc-challan-k">Offense date</span><span className="fc-challan-v">{day(detailChallan.offenseDate)}</span></div>
                  <div><span className="fc-challan-k"><Building2 size={12} /> Authority</span><span className="fc-challan-v">{authorityText(detailChallan.issuingAuthority)}</span></div>
                  <div><span className="fc-challan-k">Source</span><span className="fc-challan-v">{sourceText(detailChallan.source)}</span></div>
                </div>

                <div className="fc-challan-offense">
                  <span className="fc-challan-k">Violation</span>
                  <p>{detailChallan.offenseDescription || "No violation detail recorded."}</p>
                </div>

                <div className={`fc-challan-evidence${evidenceLink ? "" : " empty"}`}>
                  <span className="fc-challan-evidence-ico"><ImageIcon size={16} /></span>
                  {evidenceLink ? (
                    <>
                      <div>
                        <strong>Evidence on file</strong>
                        <small>AI-camera image / notice stored in Google Drive</small>
                      </div>
                      <button className="fc-button secondary" type="button" onClick={() => setEvidenceOpen(true)}>
                        Open evidence <ImageIcon size={13} />
                      </button>
                    </>
                  ) : (
                    <div><strong>No evidence linked</strong><small>No image or notice is attached to this challan yet.</small></div>
                  )}
                </div>

                {hasRecoveryCase ? (
                  <div className="fc-challan-recovery-banner">
                    <ShieldCheck size={16} />
                    <div>
                      <strong>In the NL/SLP recovery ledger</strong>
                      <small>Assign the responsible associate/UTR and split installments in Team Ops.</small>
                    </div>
                    <a className="fc-button secondary" href={detail.recoveryHref || recoveryHref(detailChallan)} target="_blank" rel="noreferrer">
                      Open recovery <ExternalLink size={13} />
                    </a>
                  </div>
                ) : null}

                {canEdit ? (
                  <div className="fc-challan-review">
                    <label className="fc-challan-note">
                      Review note / responsible associate
                      <textarea maxLength={2000} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who should recover this, and any dispute notes." />
                    </label>
                    <div className="fc-challan-actions">
                      <button className="fc-button primary" type="button" disabled={busy || detailChallan.amount <= 0} onClick={() => setPending({ kind: "recovery" })}>
                        {hasRecoveryCase ? "Refresh recovery case" : "Approve & open recovery"}
                      </button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => setPending({ kind: "status", status: "disputed" })}>Mark disputed</button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => setPending({ kind: "status", status: "paid_external" })}>Paid outside DropX</button>
                      <button className="fc-button secondary" type="button" disabled={busy} onClick={() => setPending({ kind: "status", status: "disposed" })}>Disposed / closed</button>
                      <button className="fc-button danger" type="button" disabled={busy} onClick={() => setPending({ kind: "status", status: "cancelled" })}>Cancel challan</button>
                    </div>
                  </div>
                ) : (
                  <p className="fc-challan-readonly">Contact a Fleet editor to review or open recovery for this challan.</p>
                )}

                <div className="fc-challan-activity">
                  <h3>Activity</h3>
                  <div className="fc-activity-list">
                    {detail.events.map((event) => (
                      <div key={event.id}>
                        <span>{day(event.createdAt)}</span>
                        <div>
                          <strong>{event.action.replaceAll("_", " ")}{event.toStatus ? ` → ${statusLabel[event.toStatus as ChallanStatus] || event.toStatus}` : ""}</strong>
                          <small>{event.actorName}{event.note ? ` · ${event.note}` : ""}</small>
                        </div>
                      </div>
                    ))}
                    {!detail.events.length ? <p className="fc-challan-readonly">No events yet.</p> : null}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {confirmSpec && detailChallan ? (
        <div className="fc-modal-backdrop fc-confirm-backdrop">
          <section className="fc-modal fc-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="challan-confirm-title">
            <div className="fc-confirm-head">
              <span className={`fc-confirm-ico ${confirmSpec.tone}`}>
                {confirmSpec.tone === "danger" ? <AlertTriangle size={20} /> : confirmSpec.tone === "primary" ? <ShieldCheck size={20} /> : <Check size={20} />}
              </span>
              <h2 id="challan-confirm-title">{confirmSpec.title}</h2>
            </div>
            <p className="fc-confirm-body">{confirmSpec.body}</p>
            {confirmSpec.requireNote && !note.trim() ? (
              <p className="fc-confirm-hint">Tip: add a review note first so the reason is logged.</p>
            ) : null}
            <div className="fc-confirm-actions">
              <button className="fc-button secondary" type="button" disabled={busy} onClick={() => setPending(null)}>Go back</button>
              <button className={`fc-button ${confirmSpec.tone === "danger" ? "danger" : "primary"}`} type="button" disabled={busy} onClick={() => void confirmPending()}>
                {busy ? "Working…" : confirmSpec.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {evidenceOpen && detailChallan && evidenceViewSrc ? (
        <div className="fc-modal-backdrop fc-evidence-backdrop" onClick={() => setEvidenceOpen(false)}>
          <section
            className="fc-evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="challan-evidence-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="fc-evidence-head">
              <div className="fc-evidence-head-text">
                <strong id="challan-evidence-title">Evidence · {detailChallan.challanNumber}</strong>
                <small>{detailChallan.vehicleNo} · {detailChallan.stationCode}</small>
              </div>
              <div className="fc-evidence-tools">
                <a
                  className="fc-button secondary"
                  href={evidenceProxy ? `${evidenceProxy}?download=1` : evidenceViewSrc}
                  download
                  target={evidenceProxy ? undefined : "_blank"}
                  rel={evidenceProxy ? undefined : "noreferrer"}
                >
                  <Download size={14} /> Download
                </a>
                <button
                  className="fc-button secondary"
                  type="button"
                  onClick={() => {
                    const el = document.getElementById("fc-evidence-stage");
                    if (el?.requestFullscreen) void el.requestFullscreen();
                  }}
                >
                  <Maximize2 size={14} /> Full screen
                </button>
                <a className="fc-button secondary" href={evidenceViewSrc} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> New tab
                </a>
                <button className="fc-button icon" type="button" onClick={() => setEvidenceOpen(false)} aria-label="Close">
                  <X size={18} />
                </button>
              </div>
            </header>
            <div className="fc-evidence-stage" id="fc-evidence-stage">
              {evidenceIsPdf ? (
                <iframe title="Challan evidence" src={evidenceViewSrc} className="fc-evidence-frame" />
              ) : (
                <img src={evidenceViewSrc} alt={`Evidence for challan ${detailChallan.challanNumber}`} className="fc-evidence-img" />
              )}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
