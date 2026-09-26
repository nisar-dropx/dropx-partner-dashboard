"use client";

import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileCheck2,
  Gauge,
  History,
  LayoutDashboard,
  ListChecks,
  Menu,
  MoreHorizontal,
  PlugZap,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  UserCog,
  Video,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PaymentApprovalActionForm } from "@/components/payment-approval-action-form";
import { FleetBrand } from "@/components/fleet-brand";
import { FleetAdHocCapacity } from "@/components/fleet-adhoc-capacity";
import { FleetTrackingWorkspace } from "@/components/fleet-tracking-workspace";
import type { FleetAudit, FleetAuditSuggestion, FleetControlData, FleetControlPayment, FleetControlVehicle } from "@/lib/fleet-control";

type Section = "overview" | "vehicles" | "tracking" | "service" | "audits" | "approvals" | "adhoc" | "settings";

const sections: Array<{ key: Section; label: string; icon: typeof LayoutDashboard }> = [
  { key: "overview", label: "Command Center", icon: LayoutDashboard },
  { key: "vehicles", label: "Vehicles", icon: Truck },
  { key: "tracking", label: "Tracking & Efficiency", icon: Gauge },
  { key: "service", label: "Service History", icon: History },
  { key: "audits", label: "Vehicle Audits", icon: ClipboardCheck },
  { key: "approvals", label: "Vehicle Payments", icon: CircleDollarSign },
  { key: "adhoc", label: "Ad-hoc Capacity", icon: Activity },
  { key: "settings", label: "Settings & Access", icon: Settings }
];

const validSections = new Set(sections.map((section) => section.key));
const statusOptions = [
  { api: "active", key: "active", label: "Active" },
  { api: "repair", key: "under_service", label: "Under service" },
  { api: "breakdown", key: "breakdown", label: "Breakdown" },
  { api: "inactive", key: "inactive", label: "Inactive" },
  { api: "returned", key: "returned", label: "Returned" }
];

function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function date(value: string | null | undefined, includeYear = true) {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
    timeZone: "Asia/Kolkata"
  }).format(parsed);
}

function statusTone(status: string) {
  if (status === "active" || status === "approved" || status === "paid") return "good";
  if (status === "under_service" || status === "in approval" || status === "processing") return "warn";
  if (status === "breakdown" || status === "rejected") return "bad";
  return "neutral";
}

function escapeCsv(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadCsv(name: string, rows: unknown[][]) {
  const content = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function documentMessage(vehicle: FleetControlVehicle) {
  if (vehicle.nextDocumentDays == null) return "Expiry dates incomplete";
  if (vehicle.nextDocumentDays < 0) return `${vehicle.nextDocument} expired ${Math.abs(vehicle.nextDocumentDays)}d ago`;
  if (vehicle.nextDocumentDays === 0) return `${vehicle.nextDocument} expires today`;
  return `${vehicle.nextDocument} in ${vehicle.nextDocumentDays}d`;
}

function PlacementFilter({ options, value, onChange }: { options: FleetControlData["stationOptions"]; value: string; onChange: (value: string) => void }) {
  return <label className="fc-placement-filter"><span>Vehicle placement</span><select onChange={(event) => onChange(event.target.value)} value={value}><option value="ALL">All placements</option>{options.map((option) => <option key={option.code} value={option.code}>{option.code} · {option.name}</option>)}</select></label>;
}

export function FleetControlDashboard({
  approveAction,
  data,
  initialRequestId,
  initialSection,
  message,
  rejectAction,
  returnAction
}: {
  approveAction: (formData: FormData) => Promise<void>;
  data: FleetControlData;
  initialRequestId?: string;
  initialSection?: string;
  message: { type: "notice" | "error"; text: string } | null;
  rejectAction: (formData: FormData) => Promise<void>;
  returnAction: (formData: FormData) => Promise<void>;
}) {
  const router = useRouter();
  const [section, setSection] = useState<Section>(validSections.has(initialSection as Section) ? initialSection as Section : "overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState("");
  const [station, setStation] = useState("ALL");
  const [vehicleSort, setVehicleSort] = useState("vehicle");
  const [serviceSort, setServiceSort] = useState("date_desc");
  const [auditSort, setAuditSort] = useState("date_desc");
  const [paymentSort, setPaymentSort] = useState("date_desc");
  const [vehicles, setVehicles] = useState(data.vehicles);
  const [selectedVehicle, setSelectedVehicle] = useState<FleetControlVehicle | null>(null);
  const [selectedPayment, setSelectedPayment] = useState<FleetControlPayment | null>(() => data.payments.find((payment) => payment.id === initialRequestId) ?? null);
  const [savingVehicle, setSavingVehicle] = useState<string | null>(null);
  const [flash, setFlash] = useState(message);
  const [addVehicle, setAddVehicle] = useState(false);
  const [serviceModal, setServiceModal] = useState(false);
  const [auditModal, setAuditModal] = useState<FleetAuditSuggestion | null | "manual">(null);
  const [completeAudit, setCompleteAudit] = useState<FleetAudit | null>(null);
  const [checklistModal, setChecklistModal] = useState(false);
  const [memberModal, setMemberModal] = useState(false);
  const [savingAction, setSavingAction] = useState<string | null>(null);

  useEffect(() => {
    const updateFromUrl = () => {
      const value = new URLSearchParams(window.location.search).get("section") as Section | null;
      setSection(value && validSections.has(value) ? value : "overview");
    };
    window.addEventListener("popstate", updateFromUrl);
    return () => window.removeEventListener("popstate", updateFromUrl);
  }, []);

  function changeSection(next: Section) {
    setSection(next);
    setMobileNav(false);
    const params = new URLSearchParams(window.location.search);
    params.set("section", next);
    params.delete("notice");
    params.delete("error");
    params.delete("request");
    window.history.pushState({}, "", `${window.location.pathname}?${params.toString()}`);
  }

  const filteredVehicles = useMemo(() => vehicles.filter((vehicle) => {
    const matchStation = station === "ALL" || vehicle.stationCode === station;
    const needle = query.trim().toLowerCase();
    return matchStation && (!needle || `${vehicle.vehicleNo} ${vehicle.model} ${vehicle.stationCode} ${vehicle.statusLabel}`.toLowerCase().includes(needle));
  }).sort((a, b) => vehicleSort === "placement" ? a.stationCode.localeCompare(b.stationCode) || a.vehicleNo.localeCompare(b.vehicleNo) : vehicleSort === "status" ? a.statusLabel.localeCompare(b.statusLabel) || a.vehicleNo.localeCompare(b.vehicleNo) : vehicleSort === "document" ? (a.nextDocumentDays ?? 9999) - (b.nextDocumentDays ?? 9999) : a.vehicleNo.localeCompare(b.vehicleNo)), [query, station, vehicleSort, vehicles]);

  const filteredPayments = useMemo(() => data.payments.filter((payment) => {
    const matchStation = station === "ALL" || payment.stationCode === station;
    const needle = query.trim().toLowerCase();
    return matchStation && (!needle || `${payment.requestNo} ${payment.head} ${payment.stationCode} ${payment.requestedBy}`.toLowerCase().includes(needle));
  }).sort((a, b) => paymentSort === "amount_desc" ? b.amount - a.amount : paymentSort === "placement" ? a.stationCode.localeCompare(b.stationCode) : paymentSort === "head" ? a.head.localeCompare(b.head) : b.requestedAt.localeCompare(a.requestedAt)), [data.payments, paymentSort, query, station]);

  const filteredService = useMemo(() => data.serviceHistory.filter((item) => {
    const needle = query.trim().toLowerCase();
    return (station === "ALL" || item.stationCode === station) && (!needle || `${item.vehicleNo} ${item.stationCode} ${item.serviceType} ${item.vendorName}`.toLowerCase().includes(needle));
  }).sort((a, b) => serviceSort === "amount_desc" ? b.amount - a.amount : serviceSort === "vehicle" ? a.vehicleNo.localeCompare(b.vehicleNo) : serviceSort === "placement" ? a.stationCode.localeCompare(b.stationCode) : b.serviceDate.localeCompare(a.serviceDate)), [data.serviceHistory, query, serviceSort, station]);

  const filteredAudits = useMemo(() => data.audits.filter((item) => {
    const needle = query.trim().toLowerCase();
    return (station === "ALL" || item.stationCode === station) && (!needle || `${item.vehicleNo} ${item.stationCode} ${item.status} ${item.scheduledReason}`.toLowerCase().includes(needle));
  }).sort((a, b) => auditSort === "risk_desc" ? b.riskScore - a.riskScore : auditSort === "vehicle" ? a.vehicleNo.localeCompare(b.vehicleNo) : auditSort === "status" ? a.status.localeCompare(b.status) : b.scheduledFor.localeCompare(a.scheduledFor)), [auditSort, data.audits, query, station]);

  const active = vehicles.filter((vehicle) => vehicle.status === "active").length;
  const underService = vehicles.filter((vehicle) => ["under_service", "breakdown"].includes(vehicle.status)).length;
  const availability = vehicles.length ? Math.round((active / vehicles.length) * 100) : 0;
  const pendingPayments = data.payments.filter((payment) => payment.canApprove);
  const attentionVehicles = vehicles.filter((vehicle) => vehicle.nextDocumentDays != null && vehicle.nextDocumentDays <= 30);
  const todayAdHoc = data.adHocRows.filter((row) => row.date === data.today);

  async function updateVehicleStatus(vehicle: FleetControlVehicle, apiStatus: string, nextKey: string, nextLabel: string) {
    setSavingVehicle(vehicle.vehicleNo);
    setFlash(null);
    try {
      const response = await fetch("/api/fleet/vehicles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_no: vehicle.vehicleNo, status: apiStatus })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Vehicle status could not be updated.");
      setVehicles((current) => current.map((row) => row.vehicleNo === vehicle.vehicleNo ? { ...row, status: nextKey, statusLabel: nextLabel } : row));
      setSelectedVehicle((current) => current?.vehicleNo === vehicle.vehicleNo ? { ...current, status: nextKey, statusLabel: nextLabel } : current);
      setFlash({ type: "notice", text: `${vehicle.vehicleNo} marked ${nextLabel.toLowerCase()}.` });
      router.refresh();
    } catch (error) {
      setFlash({ type: "error", text: error instanceof Error ? error.message : "Vehicle status could not be updated." });
    } finally {
      setSavingVehicle(null);
    }
  }

  async function createVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSavingVehicle("NEW");
    setFlash(null);
    try {
      const body = Object.fromEntries(form.entries());
      const response = await fetch("/api/fleet/vehicles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Vehicle could not be added.");
      setAddVehicle(false);
      setFlash({ type: "notice", text: `${String(body.vehicle_no).toUpperCase()} added to Fleet Control.` });
      router.refresh();
    } catch (error) {
      setFlash({ type: "error", text: error instanceof Error ? error.message : "Vehicle could not be added." });
    } finally {
      setSavingVehicle(null);
    }
  }

  async function fleetAction(action: string, payload: Record<string, unknown>, close?: () => void) {
    setSavingAction(action); setFlash(null);
    try {
      const response = await fetch("/api/fleet-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Fleet action could not be completed.");
      close?.(); setFlash({ type: "notice", text: result.message || "Fleet action completed." }); router.refresh();
    } catch (error) { setFlash({ type: "error", text: error instanceof Error ? error.message : "Fleet action could not be completed." }); }
    finally { setSavingAction(null); }
  }

  async function submitService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    await fleetAction("service.create", values, () => setServiceModal(false));
  }

  async function submitAuditSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    await fleetAction("audit.schedule", values, () => setAuditModal(null));
  }

  async function submitAuditCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!completeAudit) return; const form = new FormData(event.currentTarget);
    const items = data.checklistItems.filter((item) => item.templateId === completeAudit.templateId);
    const responses = items.map((item) => { const value = String(form.get(`item_${item.id}`) ?? ""); return { itemId: item.id, value, passed: value === "pass" || value === "yes" ? true : value === "fail" || value === "no" ? false : null, comments: String(form.get(`comment_${item.id}`) ?? "") }; });
    const evidence = [{ type: "photo", url: String(form.get("photoUrl") ?? ""), caption: "Vehicle audit photo evidence" }, { type: "video", url: String(form.get("videoUrl") ?? ""), caption: "Vehicle walk-around audit video" }].filter((item) => item.url);
    const finding = String(form.get("finding") ?? "");
    await fleetAction("audit.complete", { auditId: completeAudit.id, odometerKm: form.get("odometerKm"), summary: form.get("summary"), sendEmail: form.get("sendEmail") === "on", responses, evidence, findings: finding ? [{ category: form.get("findingCategory"), finding, severity: form.get("severity"), actionRequired: form.get("actionRequired"), expectedCompletionDate: form.get("expectedCompletionDate") }] : [] }, () => setCompleteAudit(null));
  }

  async function submitChecklist(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await fleetAction("checklist.create", Object.fromEntries(new FormData(event.currentTarget).entries()), () => setChecklistModal(false)); }
  async function submitMember(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await fleetAction("member.upsert", { ...Object.fromEntries(form.entries()), hasAllLocationAccess: form.get("hasAllLocationAccess") === "on", isActive: true }, () => setMemberModal(false)); }
  async function submitSettings(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await fleetAction("settings.update", { ...Object.fromEntries(form.entries()), autoSuggestAudits: form.get("autoSuggestAudits") === "on", auditEmailEnabled: form.get("auditEmailEnabled") === "on", auditVideoRequired: form.get("auditVideoRequired") === "on", breakdownVehicleLinkRequired: form.get("breakdownVehicleLinkRequired") === "on" }); }

  const title = sections.find((item) => item.key === section)?.label ?? "Command Center";

  return (
    <main className="fc-app">
      <aside className={`fc-sidebar ${mobileNav ? "open" : ""}`}>
        <button aria-label="Close navigation" className="fc-nav-close" onClick={() => setMobileNav(false)} type="button"><X size={20} /></button>
        <div className="fc-brand"><FleetBrand compact /></div>
        <div className="fc-nav-label">Workspace</div>
        <nav className="fc-nav">
          {sections.map((item) => {
            const Icon = item.icon;
            const badge = item.key === "approvals" && pendingPayments.length ? pendingPayments.length : item.key === "audits" && data.counts.auditsDue ? data.counts.auditsDue : item.key === "adhoc" && todayAdHoc.length ? todayAdHoc.length : null;
            return <button className={section === item.key ? "active" : ""} key={item.key} onClick={() => changeSection(item.key)} type="button"><Icon size={18} /><span>{item.label}</span>{badge ? <em>{badge}</em> : null}</button>;
          })}
        </nav>
        <div className="fc-sidebar-spacer" />
        <section className="fc-system-card">
          <span><i /> Live data</span>
          <strong>{data.stationOptions.length} stations connected</strong>
          <small>Updated {new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(data.generatedAt))}</small>
        </section>
        <div className="fc-user-card">
          <span>{data.operator.name.slice(0, 1).toUpperCase()}</span>
          <div><strong>{data.operator.name}</strong><small>{data.operator.role}</small></div>
          <MoreHorizontal size={18} />
        </div>
      </aside>

      {mobileNav ? <button aria-label="Close navigation overlay" className="fc-overlay" onClick={() => setMobileNav(false)} type="button" /> : null}

      <section className="fc-workspace">
        <header className="fc-topbar">
          <button aria-label="Open navigation" className="fc-menu" onClick={() => setMobileNav(true)} type="button"><Menu size={20} /></button>
          <div><span>Fleet Control</span><strong>{title}</strong></div>
          <label className="fc-search"><Search size={17} /><input onChange={(event) => setQuery(event.target.value)} placeholder="Search vehicle, station or request" value={query} /></label>
          <button aria-label="Notifications" className="fc-icon-button" type="button"><Bell size={18} />{pendingPayments.length ? <i /> : null}</button>
        </header>

        <div className="fc-content">
          {flash ? <div className={`fc-flash ${flash.type}`}><span>{flash.type === "notice" ? <Check size={17} /> : <AlertTriangle size={17} />}{flash.text}</span><button aria-label="Dismiss" onClick={() => setFlash(null)} type="button"><X size={16} /></button></div> : null}
          {data.errors.length ? <div className="fc-flash error"><span><AlertTriangle size={17} />Some live data is unavailable: {data.errors[0]}</span></div> : null}

          {section === "overview" ? <>
            <section className="fc-hero">
              <div>
                <span className="fc-eyebrow"><ShieldCheck size={14} /> Fleet operations · {date(data.today)}</span>
                <h1>Keep every vehicle moving.</h1>
                <p>One control room for availability, vehicle expenses, documents and daily ad-hoc van demand.</p>
              </div>
              <div className="fc-hero-actions">
                <button className="fc-button secondary" onClick={() => changeSection("tracking")} type="button"><Gauge size={16} /> Live GPS & mileage</button>
                {data.capabilities.canAddVehicles ? <button className="fc-button primary" onClick={() => setAddVehicle(true)} type="button"><Plus size={17} /> Add vehicle</button> : null}
              </div>
            </section>

            <section className="fc-kpis">
              <article><span className="mint"><Truck size={19} /></span><div><small>Fleet availability</small><strong>{availability}%</strong><p>{active} of {vehicles.length} vehicles active</p></div><b className="up">Live</b></article>
              <article><span className="amber"><Wrench size={19} /></span><div><small>Under service</small><strong>{underService}</strong><p>{vehicles.filter((vehicle) => vehicle.status === "breakdown").length} breakdown today</p></div><b>Action</b></article>
              <article><span className="blue"><CircleDollarSign size={19} /></span><div><small>Awaiting your approval</small><strong>{money(data.counts.pendingAmount)}</strong><p>{pendingPayments.length} vehicle payment requests</p></div><b className={pendingPayments.length ? "hot" : "up"}>{pendingPayments.length ? "Review" : "Clear"}</b></article>
              <article><span className="purple"><Activity size={19} /></span><div><small>Ad-hoc capacity today</small><strong>{todayAdHoc.length}</strong><p>{todayAdHoc.filter((row) => row.requestType === "Van").length} vans · {todayAdHoc.filter((row) => row.requestType === "Driver").length} drivers</p></div><b>View only</b></article>
            </section>

            <section className="fc-overview-grid">
              <article className="fc-panel fc-priority-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Decision queue</span><h2>Payments needing attention</h2></div><button onClick={() => changeSection("approvals")} type="button">View all <ArrowRight size={15} /></button></div>
                <div className="fc-payment-list">
                  {pendingPayments.slice(0, 5).map((payment) => <button key={payment.id} onClick={() => { setSelectedPayment(payment); changeSection("approvals"); }} type="button"><span className="fc-request-icon"><CircleDollarSign size={17} /></span><div><strong>{payment.head}</strong><small>{payment.requestNo} · {payment.stationCode} · {payment.requestedBy}</small></div><span><b>{money(payment.amount)}</b><small>{date(payment.requestedAt, false)}</small></span><ArrowRight size={16} /></button>)}
                  {!pendingPayments.length ? <div className="fc-empty compact"><ShieldCheck size={32} /><strong>Approval queue is clear</strong><p>No vehicle payment is waiting with you.</p></div> : null}
                </div>
              </article>

              <article className="fc-panel fc-availability-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Fleet health</span><h2>Vehicle availability</h2></div><button onClick={() => changeSection("vehicles")} type="button">Manage <ArrowRight size={15} /></button></div>
                <div className="fc-ring-row"><div className="fc-ring" style={{ "--availability": `${availability * 3.6}deg` } as React.CSSProperties}><span><strong>{availability}%</strong><small>available</small></span></div><div className="fc-ring-legend"><p><i className="good" /><span>Active</span><b>{active}</b></p><p><i className="warn" /><span>Under service</span><b>{vehicles.filter((vehicle) => vehicle.status === "under_service").length}</b></p><p><i className="bad" /><span>Breakdown</span><b>{vehicles.filter((vehicle) => vehicle.status === "breakdown").length}</b></p><p><i className="neutral" /><span>Other</span><b>{vehicles.length - active - underService}</b></p></div></div>
                <div className="fc-progress"><span style={{ width: `${availability}%` }} /></div>
                <small className="fc-panel-foot">Target: 90% operational availability</small>
              </article>

              <article className="fc-panel fc-ad-hoc-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Live requests</span><h2>Ad-hoc capacity</h2></div><button onClick={() => changeSection("adhoc")} type="button">Open summary <ArrowRight size={15} /></button></div>
                <div className="fc-activity-list">
                  {todayAdHoc.slice(0, 5).map((row) => <div key={`${row.id}-${row.date}`}><span>{row.stationCode}</span><div><strong>{row.requestType} · {row.reason}</strong><small>{row.reference} · {row.source}</small></div><b>{money(row.amount)}</b></div>)}
                  {!todayAdHoc.length ? <div className="fc-empty compact"><Activity size={30} /><strong>No ad-hoc request today</strong><p>Submitted van and driver requests will appear here.</p></div> : null}
                </div>
              </article>

              <article className="fc-panel fc-doc-panel">
                <div className="fc-panel-head"><div><span className="fc-eyebrow">Compliance</span><h2>Documents to renew</h2></div><button onClick={() => changeSection("vehicles")} type="button">Vehicle master <ArrowRight size={15} /></button></div>
                <div className="fc-doc-list">
                  {attentionVehicles.slice(0, 5).map((vehicle) => <button key={vehicle.vehicleNo} onClick={() => { setSelectedVehicle(vehicle); changeSection("vehicles"); }} type="button"><span className={vehicle.nextDocumentDays != null && vehicle.nextDocumentDays < 0 ? "overdue" : "due"}><FileCheck2 size={17} /></span><div><strong>{vehicle.vehicleNo}</strong><small>{documentMessage(vehicle)}</small></div><b>{vehicle.stationCode}</b></button>)}
                  {!attentionVehicles.length ? <div className="fc-empty compact"><FileCheck2 size={30} /><strong>Documents are in order</strong><p>No expiry falls within the next 30 days.</p></div> : null}
                </div>
              </article>
            </section>
          </> : null}

          {section === "vehicles" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Vehicle master</span><h1>Fleet registry</h1><p>Live allocation, availability and document readiness across every station.</p></div><div className="fc-section-actions"><PlacementFilter onChange={setStation} options={data.stationOptions} value={station} />{data.capabilities.canAddVehicles ? <button className="fc-button primary" onClick={() => setAddVehicle(true)} type="button"><Plus size={17} /> Add vehicle</button> : null}</div></div>
            <div className="fc-segment-cards"><article><small>Total fleet</small><strong>{vehicles.length}</strong></article><article><small>Active</small><strong>{active}</strong></article><article><small>Under service</small><strong>{underService}</strong></article><article><small>Document attention</small><strong>{attentionVehicles.length}</strong></article></div>
            <div className="fc-table-panel">
              <div className="fc-table-toolbar"><span>{filteredVehicles.length} vehicles</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setVehicleSort(event.target.value)} value={vehicleSort}><option value="vehicle">Vehicle number</option><option value="placement">Placement</option><option value="status">Status</option><option value="document">Document urgency</option></select></label><button onClick={() => downloadCsv(`fleet-vehicles-${data.today}.csv`, [["Vehicle","Placement","Model","Fuel","Status","Next document","Expiry"], ...filteredVehicles.map((item) => [item.vehicleNo,item.stationCode,item.model,item.fuelType,item.statusLabel,item.nextDocument,item.nextDocumentDate])])} type="button"><Download size={15} /> Download</button></div></div>
              <div className="fc-table-scroll"><table><thead><tr><th>Vehicle</th><th>Station</th><th>Type</th><th>Status</th><th>Next document</th><th>Action</th></tr></thead><tbody>
                {filteredVehicles.map((vehicle) => <tr key={vehicle.vehicleNo}><td><button className="fc-vehicle-link" onClick={() => setSelectedVehicle(vehicle)} type="button"><span><Truck size={17} /></span><div><strong>{vehicle.vehicleNo}</strong><small>{vehicle.model}</small></div></button></td><td><b className="fc-station-chip">{vehicle.stationCode}</b></td><td>{vehicle.fuelType}</td><td><span className={`fc-status ${statusTone(vehicle.status)}`}><i />{vehicle.statusLabel}</span></td><td><strong className={vehicle.nextDocumentDays != null && vehicle.nextDocumentDays <= 30 ? "fc-date-risk" : ""}>{vehicle.nextDocument ?? "Incomplete"}</strong><small className="fc-cell-note">{vehicle.nextDocumentDate ? date(vehicle.nextDocumentDate) : "No valid date"}</small></td><td><button className="fc-row-action" onClick={() => setSelectedVehicle(vehicle)} type="button">Manage <ArrowRight size={14} /></button></td></tr>)}
              </tbody></table></div>
              {!filteredVehicles.length ? <div className="fc-empty"><Search size={32} /><strong>No matching vehicle</strong><p>Change the search or vehicle placement filter.</p></div> : null}
            </div>
          </section> : null}

          {section === "service" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Maintenance lifecycle</span><h1>Service history</h1><p>Every repair, workshop bill, service due point and vehicle downtime in one timeline.</p></div><div className="fc-section-actions"><PlacementFilter onChange={setStation} options={data.stationOptions} value={station} />{data.capabilities.canManageFleet ? <button className="fc-button primary" onClick={() => setServiceModal(true)} type="button"><Plus size={17} /> Record service</button> : null}</div></div>
            <div className="fc-segment-cards"><article><small>Service records</small><strong>{data.serviceHistory.length}</strong></article><article><small>Due soon</small><strong>{data.counts.serviceDue}</strong></article><article><small>Maintenance spend</small><strong>{money(data.serviceHistory.reduce((sum, item) => sum + item.amount, 0))}</strong></article><article><small>Vehicles covered</small><strong>{new Set(data.serviceHistory.map((item) => item.vehicleId)).size}</strong></article></div>
            <div className="fc-table-panel"><div className="fc-table-toolbar"><span>{filteredService.length} maintenance events</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setServiceSort(event.target.value)} value={serviceSort}><option value="date_desc">Latest first</option><option value="vehicle">Vehicle</option><option value="placement">Placement</option><option value="amount_desc">Highest amount</option></select></label><button onClick={() => downloadCsv(`fleet-service-${data.today}.csv`, [["Date","Vehicle","Placement","Type","Vendor","Amount","Status","Next service"], ...filteredService.map((item) => [item.serviceDate,item.vehicleNo,item.stationCode,item.serviceType,item.vendorName,item.amount,item.status,item.nextServiceDate])])} type="button"><Download size={15} /> Download</button></div></div><div className="fc-table-scroll"><table><thead><tr><th>Date</th><th>Vehicle</th><th>Service / issue</th><th>Workshop</th><th>Amount</th><th>Status</th><th>Next due</th><th>Evidence</th></tr></thead><tbody>{filteredService.map((item) => <tr key={item.id}><td>{date(item.serviceDate)}</td><td><strong>{item.vehicleNo}</strong><small className="fc-cell-note">{item.stationCode}</small></td><td><strong>{item.serviceType}</strong><small className="fc-cell-note">{item.description || "No description"}</small></td><td>{item.vendorName || "—"}<small className="fc-cell-note">{item.vendorContact}</small></td><td><strong>{money(item.amount)}</strong></td><td><span className={`fc-status ${item.status === "completed" ? "good" : "warn"}`}><i />{item.status}</span></td><td>{date(item.nextServiceDate)}<small className="fc-cell-note">{item.nextServiceOdometerKm ? `${item.nextServiceOdometerKm.toLocaleString("en-IN")} km` : ""}</small></td><td>{item.invoiceUrl ? <a className="fc-link" href={item.invoiceUrl} rel="noreferrer" target="_blank">Bill <ExternalLink size={13} /></a> : "—"}</td></tr>)}</tbody></table></div>{!filteredService.length ? <div className="fc-empty"><History size={34} /><strong>No matching service history</strong><p>Change the search or vehicle placement filter.</p></div> : null}</div>
          </section> : null}

          {section === "audits" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Routine assurance</span><h1>Vehicle audits</h1><p>Risk-ranked recommendations, configurable checks, photo and video evidence, actions and audit email history.</p></div><div className="fc-section-actions"><PlacementFilter onChange={setStation} options={data.stationOptions} value={station} />{data.capabilities.canManageFleet ? <button className="fc-button primary" onClick={() => setAuditModal("manual")} type="button"><Plus size={17} /> Schedule audit</button> : null}</div></div>
            {!data.featureReady ? <div className="fc-setup-banner"><ListChecks size={20} /><div><strong>Fleet workflow migration is ready</strong><p>Apply the included migration to activate service history, audits, evidence and access management.</p></div></div> : null}
            <div className="fc-audit-layout"><article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">System suggestions</span><h2>Vehicles to audit next</h2><p>Risk combines status, documents, service and audit age.</p></div><b>{data.auditSuggestions.length}</b></div><div className="fc-recommendations">{data.auditSuggestions.slice(0,8).map((item) => <div key={item.vehicleId}><span className={`fc-risk ${item.riskScore >= 50 ? "high" : "medium"}`}>{item.riskScore}</span><div><strong>{item.vehicleNo} <small>{item.stationCode}</small></strong><p>{item.reasons.join(" · ")}</p></div>{data.capabilities.canManageFleet ? <button onClick={() => setAuditModal(item)} type="button">Schedule</button> : null}</div>)}{!data.auditSuggestions.length ? <div className="fc-empty compact"><ShieldCheck size={30} /><strong>No risk-based audit is due</strong><p>Scheduled audits and future risk signals will appear here.</p></div> : null}</div></article><article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">Audit programme</span><h2>Control summary</h2></div></div><div className="fc-audit-summary"><div><strong>{data.auditTemplates[0]?.cadenceDays ?? data.settings.defaultAuditCadenceDays} days</strong><small>Routine cadence</small></div><div><strong>{data.checklistItems.length}</strong><small>Checklist controls</small></div><div><strong>{data.audits.filter((item) => item.status === "failed").length}</strong><small>Failed audits</small></div><div><strong>{data.audits.reduce((sum,item) => sum + item.evidenceCount,0)}</strong><small>Evidence files</small></div></div><div className="fc-evidence-callout"><Video size={20} /><div><strong>Walk-around video required</strong><p>Completed audits retain photos, video links, findings, actions and email delivery status.</p></div></div></article></div>
            <div className="fc-table-panel"><div className="fc-table-toolbar"><span>{filteredAudits.length} scheduled and completed audits</span><div className="fc-toolbar-actions"><label>Sort <select onChange={(event) => setAuditSort(event.target.value)} value={auditSort}><option value="date_desc">Latest scheduled</option><option value="risk_desc">Highest risk</option><option value="vehicle">Vehicle</option><option value="status">Status</option></select></label><button onClick={() => downloadCsv(`fleet-audits-${data.today}.csv`, [["Scheduled","Vehicle","Placement","Reason","Risk","Status","Score","Evidence","Email"], ...filteredAudits.map((item) => [item.scheduledFor,item.vehicleNo,item.stationCode,item.scheduledReason,item.riskScore,item.status,item.score,item.evidenceCount,item.emailStatus])])} type="button"><Download size={15} /> Download</button></div></div><div className="fc-table-scroll"><table><thead><tr><th>Scheduled</th><th>Vehicle</th><th>Reason</th><th>Risk</th><th>Status</th><th>Score</th><th>Evidence</th><th>Email</th><th>Action</th></tr></thead><tbody>{filteredAudits.map((item) => <tr key={item.id}><td>{date(item.scheduledFor)}</td><td><strong>{item.vehicleNo}</strong><small className="fc-cell-note">{item.stationCode}</small></td><td>{item.scheduledReason}</td><td><span className={`fc-risk ${item.riskScore >= 50 ? "high" : "medium"}`}>{item.riskScore}</span></td><td><span className={`fc-status ${item.status === "passed" ? "good" : item.status === "failed" ? "bad" : "warn"}`}><i />{item.status}</span></td><td>{item.score == null ? "—" : `${item.score}%`}</td><td>{item.evidenceCount}</td><td>{item.emailStatus.replaceAll("_", " ")}</td><td>{["scheduled","in_progress"].includes(item.status) && data.capabilities.canManageFleet ? <button className="fc-row-action" onClick={() => setCompleteAudit(item)} type="button">Perform <ArrowRight size={14} /></button> : "—"}</td></tr>)}</tbody></table></div>{!filteredAudits.length ? <div className="fc-empty"><ClipboardCheck size={34} /><strong>No matching audit records</strong><p>Change the search or vehicle placement filter.</p></div> : null}</div>
          </section> : null}

          {section === "approvals" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Fleet-owned payments</span><h1>Approval desk</h1><p>Approve maintenance, service, repair, tyre and compliance expenses routed to the Fleet Manager.</p></div><div className="fc-section-actions"><PlacementFilter onChange={setStation} options={data.stationOptions} value={station} /><button className="fc-button secondary" onClick={() => downloadCsv(`fleet-payments-${data.today}.csv`, [["Request", "Placement", "Head", "Amount", "Requested by", "Created", "Status"], ...filteredPayments.map((payment) => [payment.requestNo, payment.stationCode, payment.head, payment.amount, payment.requestedBy, payment.requestedAt, payment.statusLabel])])} type="button"><Download size={16} /> Download</button></div></div>
            <div className="fc-approval-layout">
              <div className="fc-panel fc-queue">
                <div className="fc-panel-head"><div><h2>Your queue</h2><p>{pendingPayments.length} requests awaiting action</p></div><label className="fc-queue-sort">Sort<select onChange={(event) => setPaymentSort(event.target.value)} value={paymentSort}><option value="date_desc">Latest</option><option value="amount_desc">Amount</option><option value="placement">Placement</option><option value="head">Payment head</option></select></label></div>
                <div className="fc-queue-list">{filteredPayments.map((payment) => <button className={selectedPayment?.id === payment.id ? "active" : ""} key={payment.id} onClick={() => setSelectedPayment(payment)} type="button"><span className={`fc-status ${statusTone(payment.statusLabel.toLowerCase())}`}><i />{payment.statusLabel}</span><strong>{payment.head}</strong><small>{payment.requestNo} · {payment.stationCode}</small><b>{money(payment.amount)}</b></button>)}</div>
                {!filteredPayments.length ? <div className="fc-empty"><CircleDollarSign size={32} /><strong>No matching payment</strong><p>Fleet Manager-owned vehicle payments will appear here. Ad-hoc vans stay in the visibility view.</p></div> : null}
              </div>
              <div className="fc-panel fc-payment-detail">
                {selectedPayment ? <>
                  <div className="fc-detail-top"><span className="fc-request-icon"><CircleDollarSign size={19} /></span><div><small>{selectedPayment.requestNo}</small><h2>{selectedPayment.head}</h2><p>{selectedPayment.stationCode} · requested by {selectedPayment.requestedBy}</p></div><strong>{money(selectedPayment.amount)}</strong></div>
                  <div className="fc-detail-grid"><div><small>Request date</small><strong>{date(selectedPayment.requestedAt)}</strong></div><div><small>Work date</small><strong>{date(selectedPayment.workDate)}</strong></div><div><small>Approval status</small><span className={`fc-status ${statusTone(selectedPayment.statusLabel.toLowerCase())}`}><i />{selectedPayment.statusLabel}</span></div><div><small>Station</small><strong>{selectedPayment.stationCode}</strong></div></div>
                  <section className="fc-remarks"><small>Station remarks</small><p>{selectedPayment.remarks}</p></section>
                  {selectedPayment.canApprove ? <PaymentApprovalActionForm approveAction={approveAction} rejectAction={rejectAction} requestId={selectedPayment.id} requestRemarks={null} returnAction={returnAction} status="pending" /> : <div className="fc-readonly-note"><ShieldCheck size={18} /><span><strong>Decision trail protected</strong><small>This request is not currently assigned to you for approval.</small></span></div>}
                </> : <div className="fc-empty detail"><CircleDollarSign size={40} /><strong>Select a payment request</strong><p>Review the request, amount, station remarks and current approval stage.</p></div>}
              </div>
            </div>
          </section> : null}

          {section === "tracking" ? <section className="fc-section"><FleetTrackingWorkspace /></section> : null}

          {section === "adhoc" ? <section className="fc-section"><FleetAdHocCapacity rows={data.adHocRows} today={data.today} /></section> : null}

          {section === "settings" ? <section className="fc-section">
            <div className="fc-section-head"><div><span className="fc-eyebrow">Administration</span><h1>Settings & access</h1><p>Control audit policy, checklist masters, portal users and Fleet integrations.</p></div></div>
            <div className="fc-settings-grid"><article className="fc-panel fc-settings-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Fleet policy</span><h2>Audit and service rules</h2></div><Settings size={20} /></div><form className="fc-settings-form" onSubmit={submitSettings}><label><span>Routine audit cadence</span><div><input defaultValue={data.settings.defaultAuditCadenceDays} min="1" name="defaultAuditCadenceDays" type="number" /><small>days</small></div></label><label><span>Document warning</span><div><input defaultValue={data.settings.documentWarningDays} min="1" name="documentWarningDays" type="number" /><small>days</small></div></label><label><span>Service warning</span><div><input defaultValue={data.settings.serviceWarningDays} min="1" name="serviceWarningDays" type="number" /><small>days</small></div></label><label className="fc-toggle"><input defaultChecked={data.settings.autoSuggestAudits} name="autoSuggestAudits" type="checkbox" /><span>System audit suggestions</span></label><label className="fc-toggle"><input defaultChecked={data.settings.auditVideoRequired} name="auditVideoRequired" type="checkbox" /><span>Require walk-around video</span></label><label className="fc-toggle"><input defaultChecked={data.settings.auditEmailEnabled} name="auditEmailEnabled" type="checkbox" /><span>Email audit findings</span></label><label className="fc-toggle"><input defaultChecked={data.settings.breakdownVehicleLinkRequired} name="breakdownVehicleLinkRequired" type="checkbox" /><span>Activate breakdown-to-vehicle link</span><small>Keep off until the ad-hoc request form is released.</small></label>{data.capabilities.canManageSettings ? <button className="fc-button primary" disabled={savingAction === "settings.update"} type="submit">Save policy</button> : null}</form></article>
              <article className="fc-panel fc-settings-card"><div className="fc-panel-head"><div><span className="fc-eyebrow">Integrations</span><h2>Connected vehicle data</h2></div><PlugZap size={20} /></div><div className="fc-integration-list">{data.integrations.map((integration) => <div key={integration.key}><span className={`fc-integration-mark ${integration.key}`}>{integration.key === "paytap" ? "P" : "W"}</span><div><strong>{integration.name}</strong><p>{integration.purpose}</p><small>{integration.detail}{integration.lastSyncAt ? ` · Last sync ${date(integration.lastSyncAt)}` : ""}</small></div><b className={integration.status}>{integration.status.replaceAll("_", " ")}</b></div>)}</div></article>
            </div>
            <div className="fc-settings-grid lower"><article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">Master</span><h2>Routine audit checklist</h2><p>{data.checklistItems.length} configured controls</p></div>{data.capabilities.canManageSettings ? <button onClick={() => setChecklistModal(true)} type="button">Add item <Plus size={14} /></button> : null}</div><div className="fc-master-list">{data.checklistItems.map((item) => <div key={item.id}><span>{item.sortOrder}</span><div><strong>{item.label}</strong><small>{item.category} · {item.responseType.replaceAll("_", " ")} · {item.failureSeverity}</small></div>{item.isRequired ? <b>Required</b> : null}</div>)}</div></article><article className="fc-panel"><div className="fc-panel-head"><div><span className="fc-eyebrow">User access</span><h2>Fleet portal users</h2><p>Role and station-scoped access</p></div>{data.capabilities.canManageSettings ? <button onClick={() => setMemberModal(true)} type="button">Add user <Plus size={14} /></button> : null}</div><div className="fc-member-list">{data.members.map((member) => <div key={member.id}><span><UserCog size={17} /></span><div><strong>{member.name}</strong><small>{member.email} · {member.scope}</small></div><b>{member.accessLevel}</b></div>)}{!data.members.length ? <div className="fc-empty compact"><UserCog size={30} /><strong>No Fleet-specific users</strong><p>Existing dashboard permissions remain the access fallback.</p></div> : null}</div></article></div>
          </section> : null}
        </div>
      </section>

      {selectedVehicle ? <div className="fc-modal-backdrop" role="presentation"><section aria-label={`Manage ${selectedVehicle.vehicleNo}`} className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setSelectedVehicle(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Truck size={25} /></span><div><small>{selectedVehicle.stationCode} · {selectedVehicle.fuelType}</small><h2>{selectedVehicle.vehicleNo}</h2><p>{selectedVehicle.model}</p></div></div><div className="fc-document-grid">{[["Registration", selectedVehicle.registrationExpiry], ["Insurance", selectedVehicle.insuranceExpiry], ["PUC", selectedVehicle.pucExpiry], ["Fitness", selectedVehicle.fitnessExpiry], ["Tax", selectedVehicle.taxExpiry]].map(([label, value]) => <div key={label}><small>{label}</small><strong>{date(value)}</strong></div>)}</div><div className="fc-status-control"><small>Operational status</small><div>{statusOptions.map((option) => <button className={selectedVehicle.status === option.key ? "active" : ""} disabled={!data.capabilities.canEditVehicles || savingVehicle === selectedVehicle.vehicleNo} key={option.key} onClick={() => updateVehicleStatus(selectedVehicle, option.api, option.key, option.label)} type="button"><i />{option.label}</button>)}</div></div>{!data.capabilities.canEditVehicles ? <div className="fc-readonly-note"><ShieldCheck size={18} /><span><strong>View-only vehicle access</strong><small>Your role cannot change operational status.</small></span></div> : null}</section></div> : null}

      {addVehicle ? <div className="fc-modal-backdrop" role="presentation"><section aria-label="Add vehicle" className="fc-modal wide"><button aria-label="Close" className="fc-modal-close" onClick={() => setAddVehicle(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Plus size={25} /></span><div><small>Vehicle master</small><h2>Add a fleet vehicle</h2><p>Start with allocation and compliance details.</p></div></div><form className="fc-add-form" onSubmit={createVehicle}><label><span>Vehicle number</span><input autoFocus name="vehicle_no" placeholder="KL 00 XX 0000" required /></label><label><span>Station</span><select name="station_code" required><option value="">Select station</option>{data.stationOptions.map((option) => <option key={option.code} value={option.code}>{option.code} · {option.name}</option>)}</select></label><label><span>Model</span><input name="model" placeholder="Vehicle make and model" required /></label><label><span>Fuel type</span><select name="fuel_type" required><option value="">Select fuel</option><option>Diesel</option><option>Petrol</option><option>CNG</option><option>EV</option></select></label><label><span>Status</span><select defaultValue="active" name="status"><option value="active">Active</option><option value="repair">Under service</option><option value="breakdown">Breakdown</option><option value="inactive">Inactive</option></select></label><label><span>RC location</span><input name="rc_location" placeholder="RTO / station" /></label><label><span>Insurance expiry</span><input name="insurance_expiry" type="date" /></label><label><span>PUC expiry</span><input name="puc_expiry" type="date" /></label><label><span>Fitness expiry</span><input name="fitness_expiry" type="date" /></label><label><span>Tax expiry</span><input name="tax_expiry" type="date" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setAddVehicle(false)} type="button">Cancel</button><button className="fc-button primary" disabled={savingVehicle === "NEW"} type="submit">{savingVehicle === "NEW" ? "Adding…" : "Add vehicle"}</button></div></form></section></div> : null}

      {serviceModal ? <div className="fc-modal-backdrop"><section className="fc-modal wide"><button aria-label="Close" className="fc-modal-close" onClick={() => setServiceModal(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Wrench size={24} /></span><div><small>Maintenance</small><h2>Record service or repair</h2><p>Link cost, bill evidence and the next due point to the vehicle.</p></div></div><form className="fc-add-form" onSubmit={submitService}><label><span>Vehicle</span><select name="vehicleId" required><option value="">Select vehicle</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNo} · {vehicle.stationCode}</option>)}</select></label><label><span>Service date</span><input defaultValue={data.today} name="serviceDate" required type="date" /></label><label><span>Service / issue type</span><select name="serviceType" required><option>Regular Service</option><option>Tyre Change</option><option>Tyre Puncture</option><option>Oil Change</option><option>Brake Service</option><option>Battery Check/Replacement</option><option>Electrical/Lighting</option><option>Clutch & Transmission</option><option>Body & Chassis Repair</option><option>Accident</option><option>AD BLUE</option><option>Water Service</option><option>Breakdown Repair</option><option>Other</option></select></label><label><span>Status</span><select name="status"><option value="completed">Completed</option><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option></select></label><label><span>Odometer km</span><input min="0" name="odometerKm" type="number" /></label><label><span>Amount</span><input min="0" name="amount" step="0.01" type="number" /></label><label><span>Workshop / technician</span><input name="vendorName" /></label><label><span>Workshop contact</span><input name="vendorContact" /></label><label className="full"><span>Description</span><textarea name="description" rows={3} /></label><label className="full"><span>Bill / Drive evidence link</span><input name="invoiceUrl" placeholder="https://" type="url" /></label><label><span>Next service date</span><input name="nextServiceDate" type="date" /></label><label><span>Next service odometer</span><input min="0" name="nextServiceOdometerKm" type="number" /></label><label><span>Downtime hours</span><input min="0" name="downtimeHours" step="0.5" type="number" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setServiceModal(false)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "service.create"} type="submit">Save service</button></div></form></section></div> : null}

      {auditModal ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setAuditModal(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ClipboardCheck size={24} /></span><div><small>Audit programme</small><h2>Schedule vehicle audit</h2><p>Use the default routine checklist or a configured template.</p></div></div><form className="fc-add-form" onSubmit={submitAuditSchedule}><label className="full"><span>Vehicle</span><select defaultValue={auditModal === "manual" ? "" : auditModal.vehicleId} name="vehicleId" required><option value="">Select vehicle</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNo} · {vehicle.stationCode} · {vehicle.model}</option>)}</select></label><label><span>Audit date</span><input defaultValue={auditModal === "manual" ? data.today : auditModal.recommendedFor} name="scheduledFor" required type="date" /></label><label><span>Checklist template</span><select name="templateId"><option value="">Default routine audit</option>{data.auditTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.itemCount} checks</option>)}</select></label><label className="full"><span>Reason</span><input defaultValue={auditModal === "manual" ? "Routine scheduled audit" : auditModal.reasons.join("; ")} name="scheduledReason" required /></label><input name="riskScore" type="hidden" value={auditModal === "manual" ? 0 : auditModal.riskScore} /><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setAuditModal(null)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "audit.schedule"} type="submit">Schedule audit</button></div></form></section></div> : null}

      {completeAudit ? <div className="fc-modal-backdrop"><section className="fc-modal audit"><button aria-label="Close" className="fc-modal-close" onClick={() => setCompleteAudit(null)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ListChecks size={24} /></span><div><small>{completeAudit.stationCode} · {date(completeAudit.scheduledFor)}</small><h2>{completeAudit.vehicleNo} audit</h2><p>Complete every required control and attach the inspection evidence.</p></div></div><form className="fc-audit-form" onSubmit={submitAuditCompletion}><div className="fc-audit-items">{data.checklistItems.filter((item) => item.templateId === completeAudit.templateId).map((item) => <label key={item.id}><div><strong>{item.label}{item.isRequired ? " *" : ""}</strong><small>{item.category} · {item.guidance}</small></div>{["pass_fail","yes_no"].includes(item.responseType) ? <select defaultValue="" name={`item_${item.id}`} required={item.isRequired}><option value="">Select</option><option value="pass">Pass / Yes</option><option value="fail">Fail / No</option><option value="na">Not applicable</option></select> : item.responseType === "number" ? <input name={`item_${item.id}`} type="number" /> : <input name={`item_${item.id}`} placeholder="Response" />}</label>)}</div><div className="fc-audit-fields"><label><span>Odometer km</span><input min="0" name="odometerKm" type="number" /></label><label><span>Photo evidence link</span><input name="photoUrl" placeholder="Drive or storage URL" type="url" /></label><label className="full"><span>Walk-around video link *</span><input name="videoUrl" placeholder="Drive or storage URL" required={data.settings.auditVideoRequired} type="url" /></label><label className="full"><span>Audit summary</span><textarea name="summary" rows={3} /></label><label><span>Finding category</span><input name="findingCategory" placeholder="Tyres, body, documents…" /></label><label><span>Severity</span><select name="severity"><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option><option value="critical">Critical</option></select></label><label className="full"><span>Finding</span><textarea name="finding" rows={2} /></label><label className="full"><span>Required action</span><input name="actionRequired" /></label><label><span>Expected completion</span><input name="expectedCompletionDate" type="date" /></label><label className="fc-toggle"><input defaultChecked={data.settings.auditEmailEnabled} name="sendEmail" type="checkbox" /><span>Email findings to station and approvers</span></label></div><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setCompleteAudit(null)} type="button">Save later</button><button className="fc-button primary" disabled={savingAction === "audit.complete"} type="submit">Complete audit</button></div></form></section></div> : null}

      {checklistModal ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setChecklistModal(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ListChecks size={24} /></span><div><small>Checklist master</small><h2>Add an audit control</h2><p>Configure response, criticality and inspector guidance.</p></div></div><form className="fc-add-form" onSubmit={submitChecklist}><label className="full"><span>Template</span><select name="templateId" required>{data.auditTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><label><span>Category</span><input name="category" required /></label><label><span>Severity on failure</span><select name="failureSeverity"><option>low</option><option>medium</option><option>high</option><option>critical</option></select></label><label className="full"><span>Checklist item</span><input name="label" required /></label><label className="full"><span>Inspector guidance</span><textarea name="guidance" rows={3} /></label><label><span>Response type</span><select name="responseType"><option value="pass_fail">Pass / fail</option><option value="yes_no">Yes / no</option><option value="number">Number</option><option value="text">Text</option><option value="date">Date</option><option value="photo">Photo</option><option value="video">Video</option></select></label><label><span>Sort order</span><input defaultValue={data.checklistItems.length * 10 + 10} min="0" name="sortOrder" type="number" /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setChecklistModal(false)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "checklist.create"} type="submit">Add control</button></div></form></section></div> : null}

      {memberModal ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setMemberModal(false)} type="button"><X size={19} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><UserCog size={24} /></span><div><small>User access</small><h2>Add Fleet portal user</h2><p>The person must already be an active dashboard user.</p></div></div><form className="fc-add-form" onSubmit={submitMember}><label className="full"><span>User email</span><input name="email" required type="email" /></label><label><span>Access level</span><select name="accessLevel"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="approver">Approver</option><option value="administrator">Administrator</option></select></label><label className="fc-toggle field"><input defaultChecked name="hasAllLocationAccess" type="checkbox" /><span>Access all stations</span></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setMemberModal(false)} type="button">Cancel</button><button className="fc-button primary" disabled={savingAction === "member.upsert"} type="submit">Grant access</button></div></form></section></div> : null}
    </main>
  );
}
