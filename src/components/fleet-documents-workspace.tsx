"use client";

import { AlertTriangle, Check, Download, Eye, FileCheck2, FilePlus2, Search, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import { SearchableSelect } from "@/components/searchable-select";
import type { FleetControlData, FleetControlVehicle, FleetDocumentDefinition, FleetVehicleDocument } from "@/lib/fleet-control";

type DocumentState = "valid" | "expiring" | "urgent" | "expired" | "missing" | "expiry_missing";
type DocumentRow = { vehicle: FleetControlVehicle; type: FleetDocumentDefinition; document: FleetVehicleDocument | null; expiryDate: string | null; days: number | null; state: DocumentState };

const stateLabels: Record<DocumentState, string> = { valid: "Valid", expiring: "Expires in 8–30 days", urgent: "Expires in 0–7 days", expired: "Expired", missing: "Document missing", expiry_missing: "Expiry missing" };
const legacyExpiry: Record<string, keyof FleetControlVehicle> = { FLEET_REGISTRATION: "registrationExpiry", FLEET_INSURANCE: "insuranceExpiry", FLEET_PUC: "pucExpiry", FLEET_FITNESS: "fitnessExpiry", FLEET_TAX: "taxExpiry" };

function daysUntil(value: string | null, today: string) {
  if (!value) return null;
  const difference = Date.parse(`${value}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(difference) ? Math.round(difference / 86_400_000) : null;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00+05:30`);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(parsed) : value;
}

function rowState(document: FleetVehicleDocument | null, expiryDate: string | null, requiresExpiry: boolean, today: string): { state: DocumentState; days: number | null } {
  if (!document) return { state: "missing", days: daysUntil(expiryDate, today) };
  if (!requiresExpiry) return { state: "valid", days: null };
  const days = daysUntil(expiryDate, today);
  if (days == null) return { state: "expiry_missing", days };
  if (days < 0) return { state: "expired", days };
  if (days <= 7) return { state: "urgent", days };
  if (days <= 30) return { state: "expiring", days };
  return { state: "valid", days };
}

function downloadCsv(name: string, rows: unknown[][]) {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

export function FleetDocumentsWorkspace({ data, vehicles }: { data: FleetControlData; vehicles: FleetControlVehicle[] }) {
  const router = useRouter();
  const [documents, setDocuments] = useState(data.documents);
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [vehicleNos, setVehicleNos] = useState<string[]>([]);
  const [documentTypes, setDocumentTypes] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [sort, setSort] = useState("urgency");
  const [uploadRow, setUploadRow] = useState<DocumentRow | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadVehicle, setUploadVehicle] = useState("");
  const [uploadType, setUploadType] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "notice" | "error"; text: string } | null>(null);

  useEffect(() => setDocuments(data.documents), [data.documents]);

  const rows = useMemo<DocumentRow[]>(() => vehicles.flatMap((vehicle) => data.documentTypes.map((type) => {
    const document = documents.find((item) => item.vehicleNo === vehicle.vehicleNo && item.documentType === type.value) ?? null;
    const fallbackKey = legacyExpiry[type.value];
    const expiryDate = document?.expiryDate ?? (fallbackKey ? (vehicle[fallbackKey] as string | null) : null);
    return { vehicle, type, document, expiryDate, ...rowState(document, expiryDate, type.requiresExpiry, data.today) };
  })), [data.documentTypes, data.today, documents, vehicles]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    const placement = data.stationOptions.find((station) => station.code === row.vehicle.stationCode);
    return (!regions.length || regions.includes(placement?.region ?? "Unassigned region"))
      && (!clusters.length || clusters.includes(placement?.cluster ?? "Unassigned cluster"))
      && (!stations.length || stations.includes(row.vehicle.stationCode))
      && (!vehicleNos.length || vehicleNos.includes(row.vehicle.vehicleNo))
      && (!documentTypes.length || documentTypes.includes(row.type.value))
      && (!states.length || states.includes(row.state))
      && (!needle || `${row.vehicle.vehicleNo} ${row.vehicle.stationCode} ${row.vehicle.model} ${row.type.label} ${row.document?.fileName ?? ""}`.toLowerCase().includes(needle));
  }).sort((a, b) => sort === "vehicle" ? a.vehicle.vehicleNo.localeCompare(b.vehicle.vehicleNo) || a.type.sortOrder - b.type.sortOrder : sort === "station" ? a.vehicle.stationCode.localeCompare(b.vehicle.stationCode) || a.vehicle.vehicleNo.localeCompare(b.vehicle.vehicleNo) : sort === "expiry" ? (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999") : stateRank(a.state) - stateRank(b.state) || (a.days ?? 9999) - (b.days ?? 9999)), [clusters, data.stationOptions, documentTypes, query, regions, rows, sort, states, stations, vehicleNos]);

  const counts = useMemo(() => ({
    all: rows.length,
    valid: rows.filter((row) => row.state === "valid").length,
    expiring: rows.filter((row) => row.state === "expiring").length,
    urgent: rows.filter((row) => row.state === "urgent").length,
    expired: rows.filter((row) => row.state === "expired").length,
    missing: rows.filter((row) => row.state === "missing" || row.state === "expiry_missing").length
  }), [rows]);

  function openUpload(row?: DocumentRow) {
    setUploadRow(row ?? null);
    setUploadVehicle(row?.vehicle.vehicleNo ?? "");
    setUploadType(row?.type.value ?? "");
    setUploadOpen(true);
    setMessage(null);
  }

  async function refreshVehicleDocuments(vehicleNo: string) {
    const response = await fetch(`/api/fleet/documents?vehicle_no=${encodeURIComponent(vehicleNo)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to refresh vehicle documents.");
    const refreshed: FleetVehicleDocument[] = (payload.documents ?? []).map((item: any, index: number) => ({ id: `${vehicleNo}-${item.document_type}-${index}`, vehicleNo, documentType: item.document_type, fileName: item.file_name, contentType: item.content_type ?? "", fileSize: item.file_size ?? null, expiryDate: item.expiry_date ?? null, uploadedAt: item.uploaded_at ?? null, viewUrl: item.signed_url ?? "", downloadUrl: item.download_url ?? "" }));
    setDocuments((current) => [...current.filter((item) => item.vehicleNo !== vehicleNo), ...refreshed]);
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const vehicleNo = String(form.get("vehicle_no") ?? "").toUpperCase();
    setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/fleet/documents", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Document could not be uploaded.");
      await refreshVehicleDocuments(vehicleNo);
      setUploadOpen(false);
      setMessage({ tone: "notice", text: `${data.documentTypes.find((item) => item.value === String(form.get("document_type")))?.label ?? "Document"} saved for ${vehicleNo}.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Document could not be uploaded." });
    } finally { setSaving(false); }
  }

  const uniqueStations = [...new Set(vehicles.map((vehicle) => vehicle.stationCode))].sort();
  const uniqueClusters = [...new Set(data.stationOptions.map((station) => station.cluster))].filter(Boolean).sort();
  const uniqueRegions = [...new Set(data.stationOptions.map((station) => station.region))].filter(Boolean).sort();
  return <section className="fc-section fc-documents-workspace">
    <div className="fc-section-head"><div><span className="fc-eyebrow">Vehicle compliance</span><h1>Vehicle documents</h1><p>See every required file, expiry risk and missing document, then renew it from the same workspace.</p></div>{data.capabilities.canManageDocuments ? <button className="fc-button primary" onClick={() => openUpload()} type="button"><Upload size={17} /> Upload document</button> : null}</div>
    {message ? <div className={`fc-flash ${message.tone}`}><span>{message.tone === "notice" ? <Check size={17} /> : <AlertTriangle size={17} />}{message.text}</span><button aria-label="Dismiss" onClick={() => setMessage(null)} type="button"><X size={16} /></button></div> : null}

    <div className="fc-document-kpis">
      <button className={!states.length ? "active" : ""} onClick={() => setStates([])} type="button"><small>Required records</small><strong>{counts.all}</strong><span>Across {vehicles.length} vehicles</span></button>
      <button className={states.length === 1 && states[0] === "valid" ? "active valid" : "valid"} onClick={() => setStates(["valid"])} type="button"><small>Valid</small><strong>{counts.valid}</strong><span>Files in order</span></button>
      <button className={states.length === 1 && states[0] === "expiring" ? "active due" : "due"} onClick={() => setStates(["expiring"])} type="button"><small>Expires in 8–30 d</small><strong>{counts.expiring}</strong><span>Plan renewal</span></button>
      <button className={states.length === 1 && states[0] === "urgent" ? "active urgent" : "urgent"} onClick={() => setStates(["urgent"])} type="button"><small>Expires in 0–7 d</small><strong>{counts.urgent}</strong><span>Renew now</span></button>
      <button className={states.length === 1 && states[0] === "expired" ? "active expired" : "expired"} onClick={() => setStates(["expired"])} type="button"><small>Expired</small><strong>{counts.expired}</strong><span>Vehicle at risk</span></button>
      <button className={states.includes("missing") ? "active missing" : "missing"} onClick={() => setStates(["missing", "expiry_missing"])} type="button"><small>Missing</small><strong>{counts.missing}</strong><span>Upload required</span></button>
    </div>

    <div className="fc-document-filters">
      <label className="fc-document-search"><span>Search</span><div><Search size={15} /><input onChange={(event) => setQuery(event.target.value)} placeholder="Vehicle, station, file or document" value={query} /></div></label>
      <FleetMultiSelect allLabel="All regions" label="Region" onChange={setRegions} options={uniqueRegions.map((value) => ({ value, label: value }))} values={regions} />
      <FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={setClusters} options={uniqueClusters.map((value) => ({ value, label: value }))} values={clusters} />
      <FleetMultiSelect allLabel="All stations" label="Station" onChange={setStations} options={uniqueStations.map((value) => ({ value, label: value }))} values={stations} />
      <FleetMultiSelect allLabel="All vehicles" label="Vehicle" onChange={setVehicleNos} options={vehicles.map((vehicle) => ({ value: vehicle.vehicleNo, label: vehicle.vehicleNo, helper: `${vehicle.stationCode} · ${vehicle.model}` }))} values={vehicleNos} />
      <FleetMultiSelect allLabel="All document types" label="Document" onChange={setDocumentTypes} options={data.documentTypes.map((type) => ({ value: type.value, label: type.label }))} values={documentTypes} />
      <FleetMultiSelect allLabel="All expiry states" label="Expiry status" onChange={setStates} options={Object.entries(stateLabels).map(([value, label]) => ({ value, label }))} values={states} />
    </div>

    <div className="fc-table-panel">
      <div className="fc-table-toolbar"><span>{filteredRows.length} document records</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setSort(event.target.value)} value={sort}><option value="urgency">Action priority</option><option value="expiry">Expiry date</option><option value="vehicle">Vehicle</option><option value="station">Station</option></select></label><button onClick={() => downloadCsv(`fleet-documents-${data.today}.csv`, [["Vehicle", "Station", "Document", "Expiry", "Status", "Days", "File"], ...filteredRows.map((row) => [row.vehicle.vehicleNo, row.vehicle.stationCode, row.type.label, row.expiryDate, stateLabels[row.state], row.days, row.document?.fileName])])} type="button"><Download size={15} /> Download</button></div></div>
      <div className="fc-table-scroll"><table className="fc-documents-table"><thead><tr><th>Vehicle</th><th>Station</th><th>Document</th><th>Expiry</th><th>Status</th><th>File</th><th>Action</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={`${row.vehicle.vehicleNo}-${row.type.value}`}><td><strong>{row.vehicle.vehicleNo}</strong><small className="fc-cell-note">{row.vehicle.model}</small></td><td><b className="fc-station-chip">{row.vehicle.stationCode}</b></td><td><strong>{row.type.label}</strong><small className="fc-cell-note">Reminder {row.type.reminderDays} days before</small></td><td><strong className={["expired", "urgent"].includes(row.state) ? "fc-date-risk" : ""}>{formatDate(row.expiryDate)}</strong><small className="fc-cell-note">{row.days == null ? "No expiry recorded" : row.days < 0 ? `${Math.abs(row.days)} days overdue` : `${row.days} days left`}</small></td><td><span className={`fc-doc-state ${row.state}`}><i />{stateLabels[row.state]}</span></td><td>{row.document ? <><strong className="fc-doc-file">{row.document.fileName}</strong><small className="fc-cell-note">Uploaded {formatDate(row.document.uploadedAt?.slice(0, 10) ?? null)}</small></> : <span className="fc-cell-muted">No file</span>}</td><td><div className="fc-doc-actions">{row.document?.viewUrl ? <a aria-label="View document" href={row.document.viewUrl} rel="noreferrer" target="_blank"><Eye size={15} /></a> : null}{row.document?.downloadUrl ? <a aria-label="Download document" href={row.document.downloadUrl}><Download size={15} /></a> : null}{data.capabilities.canManageDocuments ? <button className={row.state === "valid" ? "secondary" : "renew"} onClick={() => openUpload(row)} type="button"><FilePlus2 size={14} />{row.document ? "Renew" : "Upload"}</button> : null}</div></td></tr>)}</tbody></table></div>
      {!filteredRows.length ? <div className="fc-empty"><FileCheck2 size={34} /><strong>No matching documents</strong><p>Change the vehicle, station, document or expiry filter.</p></div> : null}
    </div>

    {uploadOpen ? <div className="fc-modal-backdrop"><section aria-label="Upload vehicle document" className="fc-modal fc-document-upload"><button aria-label="Close" className="fc-modal-close" onClick={() => setUploadOpen(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Upload size={23} /></span><div><small>Document control</small><h2>{uploadRow?.document ? "Renew vehicle document" : "Upload vehicle document"}</h2><p>The new file becomes active; a replaced file is retained for 30 days.</p></div></div><form className="fc-add-form" onSubmit={submitUpload}><label className="full"><span>Vehicle</span><SearchableSelect name="vehicle_no" onValueChange={setUploadVehicle} options={vehicles.map((vehicle) => ({ value: vehicle.vehicleNo, label: vehicle.vehicleNo, helper: `${vehicle.stationCode} · ${vehicle.model}` }))} placeholder="Search vehicle number" required value={uploadVehicle} /></label><label className="full"><span>Document type</span><SearchableSelect name="document_type" onValueChange={setUploadType} options={data.documentTypes.map((type) => ({ value: type.value, label: type.label }))} placeholder="Search document type" required value={uploadType} /></label><label><span>New expiry date</span><input defaultValue={uploadRow?.expiryDate ?? ""} name="expiry_date" required={data.documentTypes.find((type) => type.value === uploadType)?.requiresExpiry !== false} type="date" /></label><label><span>Document file</span><input accept="application/pdf,image/jpeg,image/png,image/webp" name="file" required type="file" /><small>PDF, JPG, PNG or WebP · maximum 20 MB</small></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setUploadOpen(false)} type="button">Cancel</button><button className="fc-button primary" disabled={saving} type="submit">{saving ? "Uploading…" : "Save document"}</button></div></form></section></div> : null}
  </section>;
}

function stateRank(state: DocumentState) {
  return ({ expired: 0, missing: 1, expiry_missing: 2, urgent: 3, expiring: 4, valid: 5 } as Record<DocumentState, number>)[state];
}
