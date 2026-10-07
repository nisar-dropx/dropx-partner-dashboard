"use client";
import { FleetMobileSection } from "./fleet-mobile-section";
import { FleetVehicleMeta } from "@/components/fleet-vehicle-meta";
import { documentApplies } from "@/lib/fleet/source-policy";

import { AlertTriangle, Check, Download, Eye, FileCheck2, FilePlus2, PencilLine, Search, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FleetMultiSelect } from "@/components/fleet-multi-select";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import { SearchableSelect } from "@/components/searchable-select";
import type { FleetControlData, FleetControlVehicle, FleetDocumentDefinition, FleetVehicleDocument } from "@/lib/fleet-control";

type DocumentState = "current" | "due" | "urgent" | "expired" | "file_missing" | "validity_missing" | "linked";
type DocumentRow = { vehicle: FleetControlVehicle; type: FleetDocumentDefinition; document: FleetVehicleDocument | null; expiryDate: string | null; days: number | null; state: DocumentState };

const stateLabels: Record<DocumentState, string> = { current: "Current", due: "Due soon", urgent: "Due in 7 days", expired: "Expired", file_missing: "File missing", validity_missing: "Set validity", linked: "Follows fitness" };
const legacyExpiry: Record<string, keyof FleetControlVehicle> = { FLEET_REGISTRATION: "registrationExpiry", FLEET_INSURANCE: "insuranceExpiry", FLEET_PUC: "pucExpiry", FLEET_FITNESS: "fitnessExpiry", FLEET_TAX: "taxExpiry" };

function daysUntil(value: string | null, today: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return null;
  const difference = Date.parse(`${value.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(difference) ? Math.round(difference / 86_400_000) : null;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00+05:30`);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(parsed) : value;
}

function rowState(document: FleetVehicleDocument | null, expiryDate: string | null, type: FleetDocumentDefinition, today: string): { state: DocumentState; days: number | null } {
  if (!document) return { state: "file_missing", days: daysUntil(expiryDate, today) };
  const days = daysUntil(expiryDate, today);
  if (type.expiryMode === "linked_fitness" && days == null) return { state: "linked", days: null };
  if (type.expiryMode === "optional" && days == null) return { state: "current", days: null };
  if (type.expiryMode === "required" && days == null) return { state: "validity_missing", days: null };
  if (days == null) return { state: "current", days: null };
  if (days < 0) return { state: "expired", days };
  if (days <= 7) return { state: "urgent", days };
  if (days <= type.reminderDays) return { state: "due", days };
  return { state: "current", days };
}

function validityText(row: DocumentRow) {
  if (row.state === "linked") return "Valid with fitness certificate";
  if (row.type.expiryMode === "optional" && row.days == null) return "No validity date required";
  if (row.days == null) return row.state === "file_missing" ? "Add the document file" : "Validity date required";
  if (row.days < 0) return `${Math.abs(row.days)} days overdue`;
  return `${row.days} days left`;
}


export function FleetDocumentsWorkspace({ data, vehicles, initialVehicle, initialDocumentType }: { data: FleetControlData; vehicles: FleetControlVehicle[]; initialVehicle?:string; initialDocumentType?:string }) {
  const router = useRouter();
  const [documents, setDocuments] = useState(data.documents);
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [vehicleNos, setVehicleNos] = useState<string[]>(initialVehicle?[initialVehicle]:[]);
  const [documentTypes, setDocumentTypes] = useState<string[]>(initialDocumentType?[initialDocumentType]:[]);
  const [states, setStates] = useState<string[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<"action" | "register">("action");
  const [sort, setSort] = useState("urgency");
  const [uploadRow, setUploadRow] = useState<DocumentRow | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadVehicle, setUploadVehicle] = useState("");
  const [uploadType, setUploadType] = useState("");
  const [validityRow, setValidityRow] = useState<DocumentRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "notice" | "error"; text: string } | null>(null);

  useEffect(() => setDocuments(data.documents), [data.documents]);

  const rows = useMemo<DocumentRow[]>(() => vehicles.flatMap((vehicle) => data.documentTypes.filter(type => documentApplies(type, vehicle)).map((configuredType) => {
    const type = configuredType.expiryMode === "linked_fitness" && vehicle.ownershipType !== "own" ? {...configuredType,expiryMode:"optional" as const} : configuredType;
    const document = documents.find((item) => item.vehicleNo === vehicle.vehicleNo && item.documentType === type.value) ?? null;
    const fallbackKey = legacyExpiry[type.value];
    const expiryDate = document?.expiryDate ?? (fallbackKey ? (vehicle[fallbackKey] as string | null) : null);
    return { vehicle, type, document, expiryDate, ...rowState(document, expiryDate, type, data.today) };
  })), [data.documentTypes, data.today, documents, vehicles]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    const placement = data.stationOptions.find((station) => station.code === row.vehicle.stationCode);
    return (!regions.length || regions.includes(placement?.region ?? "Unassigned region"))
      && (!clusters.length || clusters.includes(placement?.cluster ?? "Unassigned cluster"))
      && (!stations.length || stations.includes(row.vehicle.stationCode))
      && (!vehicleNos.length || vehicleNos.includes(row.vehicle.vehicleNo))
      && (!documentTypes.length || documentTypes.includes(row.type.value))
      && (workspaceMode === "register" || ["expired", "urgent", "file_missing", "validity_missing", "due"].includes(row.state))
      && (!states.length || states.includes(row.state))
      && (!needle || `${row.vehicle.vehicleNo} ${row.vehicle.stationCode} ${row.vehicle.model} ${row.type.label} ${row.document?.fileName ?? ""}`.toLowerCase().includes(needle));
  }).sort((a, b) => sort === "vehicle" ? a.vehicle.vehicleNo.localeCompare(b.vehicle.vehicleNo) || a.type.sortOrder - b.type.sortOrder : sort === "station" ? a.vehicle.stationCode.localeCompare(b.vehicle.stationCode) || a.vehicle.vehicleNo.localeCompare(b.vehicle.vehicleNo) : sort === "expiry" ? (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999") : stateRank(a.state) - stateRank(b.state) || (a.days ?? 9999) - (b.days ?? 9999)), [clusters, data.stationOptions, documentTypes, query, regions, rows, sort, states, stations, vehicleNos, workspaceMode]);

  const counts = useMemo(() => ({
    all: rows.length,
    action: rows.filter((row) => ["expired", "urgent", "file_missing", "validity_missing"].includes(row.state)).length,
    due: rows.filter((row) => row.state === "due").length,
    current: rows.filter((row) => row.state === "current").length,
    linked: rows.filter((row) => row.state === "linked").length
  }), [rows]);

  const selectedType = rows.find(row=>row.vehicle.vehicleNo===uploadVehicle && row.type.value===uploadType)?.type;

  function openUpload(row?: DocumentRow) {
    setUploadRow(row ?? null); setUploadVehicle(row?.vehicle.vehicleNo ?? ""); setUploadType(row?.type.value ?? ""); setUploadOpen(true); setMessage(null);
  }

  async function refreshVehicleDocuments(vehicleNo: string) {
    const response = await fetch(`/api/fleet/documents?vehicle_no=${encodeURIComponent(vehicleNo)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to refresh vehicle documents.");
    const refreshed: FleetVehicleDocument[] = (payload.documents ?? []).map((item: any, index: number) => ({ id: `${vehicleNo}-${item.document_type}-${index}`, vehicleNo, documentType: item.document_type, fileName: item.file_name, contentType: item.content_type ?? "", fileSize: item.file_size ?? null, expiryDate: item.expiry_date ?? null, uploadedAt: item.uploaded_at ?? null, viewUrl: item.signed_url ?? "", downloadUrl: item.download_url ?? "" }));
    setDocuments((current) => [...current.filter((item) => item.vehicleNo !== vehicleNo), ...refreshed]);
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const vehicleNo = String(form.get("vehicle_no") ?? "").toUpperCase(); setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/fleet/documents", { method: "POST", body: form }); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Document could not be uploaded.");
      await refreshVehicleDocuments(vehicleNo); setUploadOpen(false); setMessage({ tone: "notice", text: `${data.documentTypes.find((item) => item.value === String(form.get("document_type")))?.label ?? "Document"} saved for ${vehicleNo}.` }); router.refresh();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Document could not be uploaded." }); } finally { setSaving(false); }
  }

  async function submitValidity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!validityRow) return; const form = new FormData(event.currentTarget); setSaving(true); setMessage(null);
    try {
      const response = await fetch("/api/fleet/documents", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vehicle_no: validityRow.vehicle.vehicleNo, document_type: validityRow.type.value, expiry_date: form.get("expiry_date") }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Validity could not be updated.");
      await refreshVehicleDocuments(validityRow.vehicle.vehicleNo); setValidityRow(null); setMessage({ tone: "notice", text: `${validityRow.type.label} validity updated for ${validityRow.vehicle.vehicleNo}.` }); router.refresh();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Validity could not be updated." }); } finally { setSaving(false); }
  }

  const uniqueStations = [...new Set(vehicles.map((vehicle) => vehicle.stationCode))].sort();
  const uniqueClusters = [...new Set(data.stationOptions.map((station) => station.cluster))].filter(Boolean).sort();
  const uniqueRegions = [...new Set(data.stationOptions.map((station) => station.region))].filter(Boolean).sort();
  return <section className="fc-section fc-documents-workspace">
    <div className="fc-section-head"><div><span className="fc-eyebrow">Vehicle compliance</span><h1>Vehicle documents</h1><p>Act on missing files and time-bound validity. Registration follows Fitness unless a separate RC date is recorded.</p></div>{data.capabilities.canManageDocuments ? <button className="fc-button primary" onClick={() => openUpload()} type="button"><Upload size={17} /> Upload document</button> : null}</div>
    {message ? <div className={`fc-flash ${message.tone}`}><span>{message.tone === "notice" ? <Check size={17} /> : <AlertTriangle size={17} />}{message.text}</span><button aria-label="Dismiss" onClick={() => setMessage(null)} type="button"><X size={16} /></button></div> : null}

    <div className="fc-document-mode"><nav className="fc-view-switch compact"><button className={workspaceMode === "action" ? "active" : ""} onClick={() => { setWorkspaceMode("action"); setStates([]); }} type="button"><AlertTriangle size={14} /> Action queue</button><button className={workspaceMode === "register" ? "active" : ""} onClick={() => { setWorkspaceMode("register"); setStates([]); }} type="button"><FileCheck2 size={14} /> Complete register</button></nav><p>{workspaceMode === "action" ? "Only missing, expiring and overdue controls are shown." : "Every vehicle and document rule is shown."}</p></div>
    <div className="fc-document-kpis compact">
      <button className={workspaceMode === "register" && !states.length ? "active" : ""} onClick={() => { setWorkspaceMode("register"); setStates([]); }} type="button"><small>All controls</small><strong>{counts.all}</strong><span>{vehicles.length} vehicles</span></button>
      <button className={states.length === 4 ? "active expired" : "expired"} onClick={() => { setWorkspaceMode("register"); setStates(["expired", "urgent", "file_missing", "validity_missing"]); }} type="button"><small>Action required</small><strong>{counts.action}</strong><span>Fix now</span></button>
      <button className={states.length === 1 && states[0] === "due" ? "active due" : "due"} onClick={() => { setWorkspaceMode("register"); setStates(["due"]); }} type="button"><small>Due soon</small><strong>{counts.due}</strong><span>Within reminder window</span></button>
      <button className={states.length === 1 && states[0] === "current" ? "active valid" : "valid"} onClick={() => { setWorkspaceMode("register"); setStates(["current"]); }} type="button"><small>Current</small><strong>{counts.current}</strong><span>No action</span></button>
      <button className={states.length === 1 && states[0] === "linked" ? "active linked" : "linked"} onClick={() => { setWorkspaceMode("register"); setStates(["linked"]); }} type="button"><small>Linked validity</small><strong>{counts.linked}</strong><span>RC follows Fitness</span></button>
    </div>

    <FleetMobileSection title="Search & filters" summary={[query,...regions,...clusters,...stations,...vehicleNos,...documentTypes,...states].filter(Boolean).join(" · ") || "All stations · all vehicles"} className="fc-mobile-filters"><div className="fc-document-filters">
      <label className="fc-document-search"><span>Search</span><div><Search size={15} /><input onChange={(event) => setQuery(event.target.value)} placeholder="Vehicle, station, file or document" value={query} /></div></label>
      <FleetMultiSelect allLabel="All regions" label="Region" onChange={setRegions} options={uniqueRegions.map((value) => ({ value, label: value }))} values={regions} />
      <FleetMultiSelect allLabel="All clusters" label="Cluster" onChange={setClusters} options={uniqueClusters.map((value) => ({ value, label: value }))} values={clusters} />
      <FleetMultiSelect allLabel="All stations" label="Station" onChange={setStations} options={uniqueStations.map((value) => ({ value, label: value }))} values={stations} />
      <FleetMultiSelect allLabel="All vehicles" label="Vehicle" onChange={setVehicleNos} options={vehicles.map((vehicle) => ({ value: vehicle.vehicleNo, label: vehicle.vehicleNo, helper: `${vehicle.stationCode} · ${vehicle.model}` }))} values={vehicleNos} />
      <FleetMultiSelect allLabel="All document types" label="Document" onChange={setDocumentTypes} options={data.documentTypes.filter(type => { const v=vehicles.find(v=>v.vehicleNo===uploadVehicle); return !v || documentApplies(type,v); }).map((type) => ({ value: type.value, label: type.label }))} values={documentTypes} />
      <FleetMultiSelect allLabel="All states" label="Status" onChange={setStates} options={Object.entries(stateLabels).map(([value, label]) => ({ value, label }))} values={states} />
    </div></FleetMobileSection>

    <div className="fc-table-panel">
      <div className="fc-table-toolbar"><span>{filteredRows.length} controls</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setSort(event.target.value)} value={sort}><option value="urgency">Action priority</option><option value="expiry">Validity date</option><option value="vehicle">Vehicle</option><option value="station">Station</option></select></label><FleetExportButtons compact report={{ title: "Vehicle document compliance report", subtitle: `Generated ${data.today} · active filters applied`, fileName: `fleet-documents-${data.today}`, headers: ["Vehicle", "Model", "Station", "Document", "Validity", "Status", "Days", "File"], rows: filteredRows.map((row) => [row.vehicle.vehicleNo, row.vehicle.model, row.vehicle.stationCode, row.type.label, row.expiryDate, stateLabels[row.state], row.days, row.document?.fileName]) }} /></div></div>
      <div className="fc-table-scroll"><table className="fc-documents-table compact"><thead><tr><th>Vehicle</th><th>Document rule</th><th>Validity & status</th><th>File</th><th>Next action</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={`${row.vehicle.vehicleNo}-${row.type.value}`}><td><strong>{row.vehicle.vehicleNo}</strong><small className="fc-cell-note">{row.vehicle.stationCode} · {row.vehicle.model}</small></td><td><strong>{row.type.label}</strong><small className="fc-cell-note">{row.type.expiryMode === "linked_fitness" ? "Validity follows Fitness" : row.type.expiryMode === "required" ? `Validity required · alert ${row.type.reminderDays} d before` : "Validity date optional"}</small></td><td><strong className={["expired", "urgent"].includes(row.state) ? "fc-date-risk" : ""}>{row.state === "linked" ? "As per Fitness" : formatDate(row.expiryDate)}</strong><small className="fc-cell-note">{validityText(row)}</small><span className={`fc-doc-state ${row.state}`}><i />{stateLabels[row.state]}</span></td><td>{row.document ? <><strong className="fc-doc-file">{row.document.fileName}</strong><small className="fc-cell-note">Uploaded {formatDate(row.document.uploadedAt?.slice(0, 10) ?? null)}</small></> : <span className="fc-cell-muted">No file uploaded</span>}</td><td><div className="fc-doc-actions">{row.document?.viewUrl ? <a aria-label="View document" href={row.document.viewUrl} rel="noreferrer" target="_blank"><Eye size={15} /></a> : null}{row.document?.downloadUrl ? <a aria-label="Download document" href={row.document.downloadUrl}><Download size={15} /></a> : null}{data.capabilities.canManageDocuments && row.document && row.type.expiryMode === "required" ? <button className={row.state === "validity_missing" ? "renew" : "secondary"} onClick={() => setValidityRow(row)} type="button"><PencilLine size={14} />{row.state === "validity_missing" ? "Set validity" : "Edit date"}</button> : null}{data.capabilities.canManageDocuments ? <button className={["expired", "urgent", "file_missing"].includes(row.state) ? "renew" : "secondary"} onClick={() => openUpload(row)} type="button"><FilePlus2 size={14} />{row.document ? "Replace" : "Upload"}</button> : null}</div></td></tr>)}</tbody></table></div>
      {!filteredRows.length ? <div className="fc-empty"><FileCheck2 size={34} /><strong>No matching documents</strong><p>Change the vehicle, station, document or status filter.</p></div> : null}
    </div>

    {uploadOpen ? <div className="fc-modal-backdrop"><section aria-label="Upload vehicle document" className="fc-modal fc-document-upload"><button aria-label="Close" className="fc-modal-close" onClick={() => setUploadOpen(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Upload size={23} /></span><div><small>Document control</small><h2>{uploadRow?.document ? "Replace vehicle document" : "Upload vehicle document"}</h2><p>The new file becomes active; a replaced file is retained for 30 days.</p></div></div><form className="fc-add-form" onSubmit={submitUpload}><label className="full"><span>Vehicle</span><SearchableSelect name="vehicle_no" onValueChange={value=>{setUploadVehicle(value);setUploadType("");}} options={vehicles.map((vehicle) => ({ value: vehicle.vehicleNo, label: vehicle.vehicleNo, helper: `${vehicle.stationCode} · ${vehicle.model}` }))} placeholder="Search vehicle number" required value={uploadVehicle} />{uploadVehicle?<FleetVehicleMeta vehicleNo={uploadVehicle}/>:null}</label><label className="full"><span>Document type</span><SearchableSelect name="document_type" onValueChange={setUploadType} options={data.documentTypes.filter(type => { const v=vehicles.find(v=>v.vehicleNo===uploadVehicle); return !v || documentApplies(type,v); }).map((type) => ({ value: type.value, label: type.label }))} placeholder="Search document type" required value={uploadType} /></label>{selectedType?.expiryMode === "required" ? <label><span>Valid until</span><input defaultValue={uploadRow?.expiryDate?.slice(0, 10) ?? ""} name="expiry_date" required type="date" /><small>Required for compliance alerts.</small></label> : <input name="expiry_date" type="hidden" value="" />}<label className={selectedType?.expiryMode === "required" ? "" : "full"}><span>Document file</span><input accept="application/pdf,image/jpeg,image/png,image/webp" name="file" required type="file" /><small>{selectedType?.expiryMode === "linked_fitness" ? "RC validity is tracked through the Fitness certificate. " : ""}PDF, JPG, PNG or WebP · maximum 20 MB</small></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setUploadOpen(false)} type="button">Cancel</button><button className="fc-button primary" disabled={saving} type="submit">{saving ? "Uploading…" : "Save document"}</button></div></form></section></div> : null}

    {validityRow ? <div className="fc-modal-backdrop"><section aria-label="Update document validity" className="fc-modal fc-validity-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setValidityRow(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><PencilLine size={22} /></span><div><small>{validityRow.vehicle.vehicleNo}</small><FleetVehicleMeta vehicleNo={validityRow.vehicle.vehicleNo} model={validityRow.vehicle.model} stationCode={validityRow.vehicle.stationCode}/><h2>Update {validityRow.type.label} validity</h2><p>Correct the date without uploading the same file again.</p></div></div><form className="fc-add-form" onSubmit={submitValidity}><label className="full"><span>Valid until</span><input autoFocus defaultValue={validityRow.expiryDate?.slice(0, 10) ?? ""} name="expiry_date" required type="date" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setValidityRow(null)} type="button">Cancel</button><button className="fc-button primary" disabled={saving} type="submit">{saving ? "Saving…" : "Update validity"}</button></div></form></section></div> : null}
  </section>;
}

function stateRank(state: DocumentState) {
  return ({ expired: 0, urgent: 1, file_missing: 2, validity_missing: 3, due: 4, current: 5, linked: 6 } as Record<DocumentState, number>)[state];
}
