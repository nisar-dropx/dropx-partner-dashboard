"use client";

import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  Film,
  Link as LinkIcon,
  ListChecks,
  Mail,
  MoveRight,
  Plus,
  ShieldCheck,
  UserRoundCheck,
  Video,
  X
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { FleetExportButtons } from "@/components/fleet-export-buttons";
import type { FleetAudit, FleetAuditMode, FleetControlData, FleetControlVehicle, FleetChecklistItem } from "@/lib/fleet-control";

type AuditView = "programme" | "calendar" | "history";
type ScheduleDraft = { vehicleId: string; mode: FleetAuditMode | "both"; reason: string };

const modeMeta = {
  video: { label: "Video review", short: "Video", icon: Video, detail: "Remote walk-around and evidence review" },
  physical: { label: "Physical inspection", short: "Physical", icon: UserRoundCheck, detail: "Fleet Manager inspects the vehicle in person" }
} as const;

const dateLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
const monthLabel = (value: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}-01T12:00:00+05:30`));
const isClosedVehicle = (vehicle: FleetControlVehicle) => ["sold", "disposed", "returned"].includes(vehicle.status);


function monthShift(month: string, delta: number) {
  const date = new Date(`${month}-01T12:00:00+05:30`);
  date.setMonth(date.getMonth() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function suggestedDates(month: string) {
  const today = new Date();
  const selected = new Date(`${month}-01T12:00:00+05:30`);
  const current = selected.getFullYear() === today.getFullYear() && selected.getMonth() === today.getMonth();
  const todayDay = current ? today.getDate() : 1;
  const videoDay = Math.min(Math.max(todayDay + 1, 5), 13);
  const physicalDay = Math.min(Math.max(todayDay + 3, 18), 26);
  const eligible = (day: number) => { let candidate = new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00+05:30`); while (candidate.getDay() === 0) candidate = new Date(candidate.getTime() + 86400000); return `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, "0")}-${String(candidate.getDate()).padStart(2, "0")}`; };
  return { video: eligible(videoDay), physical: eligible(physicalDay) };
}

function AuditState({ audit }: { audit?: FleetAudit }) {
  if (!audit) return <span className="fc-audit-state missing"><i />Not scheduled</span>;
  const tone = audit.status === "passed" ? "good" : audit.status === "failed" ? "bad" : audit.status === "cancelled" ? "neutral" : "planned";
  return <span className={`fc-audit-state ${tone}`}><i />{audit.status === "scheduled" ? "Scheduled" : audit.status.replaceAll("_", " ")}</span>;
}

function evidenceFor(item: FleetChecklistItem, response: string) {
  const failed = response === "fail" || response === "no";
  return failed ? { type: item.failEvidenceType, minimum: item.failMinEvidence, outcome: "non-compliant" } : { type: item.passEvidenceType, minimum: item.passMinEvidence, outcome: "compliant" };
}

function EvidenceInputs({ item, response }: { item: FleetChecklistItem; response: string }) {
  const rule = evidenceFor(item, response);
  if (!response || !rule.minimum || rule.type === "none") return null;
  return <div className="fc-audit-evidence-inputs">
    <small>{rule.minimum} {rule.type === "any" ? "evidence" : rule.type} attachment{rule.minimum > 1 ? "s" : ""} required for a {rule.outcome} result</small>
    {Array.from({ length: rule.minimum }, (_, index) => <label key={index}>
      <span>{rule.type === "any" ? "Evidence" : rule.type} link {index + 1} *</span>
      <input name={`evidence_${item.id}_${index}`} placeholder="Paste a shareable Drive or storage link" required type="url" />
    </label>)}
  </div>;
}

function AuditChecklist({ items, onResponse, responses }: { items: FleetChecklistItem[]; onResponse: (itemId: string, value: string) => void; responses: Record<string, string> }) {
  const groups = [...new Set(items.map((item) => item.category || "General"))].map((category) => ({ category, items: items.filter((item) => (item.category || "General") === category) }));
  let offset = 0;
  return <div className="fc-audit-groups">{groups.map((group, groupIndex) => {
    const start = offset; offset += group.items.length;
    const answered = group.items.filter((item) => responses[item.id]).length;
    return <details className="fc-audit-group" key={group.category} open={groupIndex === 0}>
      <summary><span><strong>{group.category}</strong><small>{group.items.length} checks</small></span><b>{answered}/{group.items.length} answered</b></summary>
      <div className="fc-audit-items">{group.items.map((item, index) => {
        const response = responses[item.id] ?? "";
        const failed = response === "fail" || response === "no";
        return <section className={`fc-audit-check ${failed ? "failed" : ""}`} key={item.id}>
          <label><div><span className="fc-check-number">{start + index + 1}</span><strong>{item.label}{item.isRequired ? " *" : ""}</strong><small>{item.guidance || "Confirm the condition and select the result."}</small><em>Pass: {item.passMinEvidence ? `${item.passMinEvidence} ${item.passEvidenceType}` : "no attachment"} · Fail: {item.failMinEvidence ? `${item.failMinEvidence} ${item.failEvidenceType}` : "no attachment"}{item.failRemarksRequired ? " + remark" : ""}</em></div>{["pass_fail","yes_no"].includes(item.responseType) ? <select name={`item_${item.id}`} onChange={(event) => onResponse(item.id, event.target.value)} required={item.isRequired} value={response}><option value="">Select result</option><option value="pass">Compliant / Yes</option><option value="fail">Non-compliant / No</option><option value="na">Not applicable</option></select> : item.responseType === "number" ? <input name={`item_${item.id}`} onChange={(event) => onResponse(item.id, event.target.value ? "pass" : "")} required={item.isRequired} type="number" /> : item.responseType === "date" ? <input name={`item_${item.id}`} onChange={(event) => onResponse(item.id, event.target.value ? "pass" : "")} required={item.isRequired} type="date" /> : <input name={`item_${item.id}`} onChange={(event) => onResponse(item.id, event.target.value ? "pass" : "")} placeholder="Response" required={item.isRequired} />}</label>
          {failed ? <label className="fc-audit-comment"><span>Why is this non-compliant?{item.failRemarksRequired ? " *" : ""}</span><textarea name={`comment_${item.id}`} placeholder="Record the issue, condition or missing document" required={item.failRemarksRequired} rows={2} /></label> : <details className="fc-optional-remark"><summary><Plus size={13} /> Add remark</summary><label className="fc-audit-comment"><span>Optional inspector remark</span><textarea name={`comment_${item.id}`} placeholder="Add context only when it helps explain this check" rows={2} /></label></details>}
          <EvidenceInputs item={item} response={response} />
        </section>;
      })}</div>
    </details>;
  })}</div>;
}

export function FleetAuditsWorkspace({ audits, data, onChanged, vehicles }: {
  audits: FleetAudit[];
  data: FleetControlData;
  onChanged: () => void;
  vehicles: FleetControlVehicle[];
}) {
  const [view, setView] = useState<AuditView>("programme");
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [schedule, setSchedule] = useState<ScheduleDraft | null>(null);
  const [reschedule, setReschedule] = useState<FleetAudit | null>(null);
  const [swap, setSwap] = useState<FleetAudit | null>(null);
  const [cancelling, setCancelling] = useState<FleetAudit | null>(null);
  const [complete, setComplete] = useState<FleetAudit | null>(null);
  const [responseDraft, setResponseDraft] = useState<Record<string, string>>({});
  const [inspect, setInspect] = useState<FleetAudit | null>(null);
  const [emailPreview, setEmailPreview] = useState(false);
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState<{ tone: "notice" | "error"; text: string } | null>(null);
  const activeVehicles = useMemo(() => vehicles.filter((vehicle) => !isClosedVehicle(vehicle)), [vehicles]);
  const monthAudits = useMemo(() => audits.filter((audit) => audit.scheduledFor.startsWith(month)), [audits, month]);
  const dates = suggestedDates(month);
  const auditFor = (vehicleId: string, mode: FleetAuditMode) => monthAudits.find((audit) => audit.vehicleId === vehicleId && audit.auditMode === mode && audit.status !== "cancelled");
  const checklistFor = (audit: FleetAudit) => {
    const templateId = audit.templateId ?? data.auditTemplates.find((template) => template.isDefault)?.id;
    return data.checklistItems.filter((item) => item.templateId === templateId && (item.auditMode === "both" || item.auditMode === audit.auditMode));
  };
  const coveredVehicles = activeVehicles.filter((vehicle) => auditFor(vehicle.id, "video") && auditFor(vehicle.id, "physical")).length;
  const videoCoverage = activeVehicles.filter((vehicle) => auditFor(vehicle.id, "video")).length;
  const physicalCoverage = activeVehicles.filter((vehicle) => auditFor(vehicle.id, "physical")).length;
  const completed = monthAudits.filter((audit) => ["passed", "failed"].includes(audit.status)).length;
  const open = monthAudits.filter((audit) => ["scheduled", "in_progress"].includes(audit.status)).length;
  const missingSlots = Math.max(0, activeVehicles.length * 2 - monthAudits.filter((audit) => audit.status !== "cancelled").length);
  const todayAudits = audits.filter((audit) => audit.scheduledFor === data.today && ["scheduled", "in_progress"].includes(audit.status));

  async function act(action: string, payload: Record<string, unknown>) {
    setSaving(action); setMessage(null);
    try {
      const response = await fetch("/api/fleet-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Audit action could not be completed.");
      setMessage({ tone: "notice", text: result.message || "Audit programme updated." });
      onChanged();
      return true;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Audit action could not be completed." });
      return false;
    } finally { setSaving(""); }
  }

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedule) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (await act("audit.schedule", { ...values, vehicleId: schedule.vehicleId, auditMode: schedule.mode, riskScore: data.auditSuggestions.find((item) => item.vehicleId === schedule.vehicleId)?.riskScore ?? 0 })) setSchedule(null);
  }

  async function submitReschedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reschedule) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (await act("audit.reschedule", { ...values, auditId: reschedule.id })) setReschedule(null);
  }

  async function submitCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) return;
    const form = new FormData(event.currentTarget);
    const items = checklistFor(complete);
    const responses = items.map((item) => { const value = String(form.get(`item_${item.id}`) ?? ""); return { itemId: item.id, value, passed: value === "pass" || value === "yes" ? true : value === "fail" || value === "no" ? false : null, comments: String(form.get(`comment_${item.id}`) ?? "") }; });
    const evidence = [
      ...items.flatMap((item) => { const rule = evidenceFor(item, String(form.get(`item_${item.id}`) ?? "")); return Array.from({ length: rule.minimum }, (_, index) => ({ itemId: item.id, type: rule.type === "any" ? "document" : rule.type, url: String(form.get(`evidence_${item.id}_${index}`) ?? ""), caption: `${item.label} · ${rule.outcome} evidence ${index + 1}` })); }),
      { itemId: null, type: "video", url: String(form.get("walkAroundVideoUrl") ?? ""), caption: "Complete vehicle walk-around video" }
    ].filter((item) => item.url);
    const finding = String(form.get("finding") ?? "");
    if (await act("audit.complete", { auditId: complete.id, odometerKm: form.get("odometerKm"), summary: form.get("summary"), sendEmail: form.get("sendEmail") === "on", responses, evidence, findings: finding ? [{ category: form.get("findingCategory"), finding, severity: form.get("severity"), actionRequired: form.get("actionRequired"), expectedCompletionDate: form.get("expectedCompletionDate") }] : [] })) setComplete(null);
  }

  function openSchedule(vehicleId = "", mode: FleetAuditMode | "both" = "both", reason = "Routine twice-monthly vehicle audit") {
    setSchedule({ vehicleId, mode, reason });
  }

  async function openAudit(audit: FleetAudit) {
    if (audit.status === "scheduled") {
      if (!await act("audit.start", { auditId: audit.id })) return;
      setComplete({ ...audit, status: "in_progress" });
    } else setComplete(audit);
    setResponseDraft({});
  }

  const renderAuditCell = (audit: FleetAudit | undefined, vehicleId: string, mode: FleetAuditMode) => <div className="fc-programme-cell">
    <AuditState audit={audit} />
    {audit ? <>
      <strong>{dateLabel(audit.scheduledFor)}</strong>
      <small>{audit.evidenceCount} evidence · {audit.score == null ? "score pending" : `${audit.score}% score`}</small>
      <div className="fc-inline-actions">
        {["scheduled", "in_progress"].includes(audit.status) && data.capabilities.canManageFleet ? <button className="fc-start-audit" onClick={() => openAudit(audit)} type="button">{audit.status === "scheduled" ? "Start audit" : "Continue audit"}</button> : null}
        {["scheduled", "in_progress"].includes(audit.status) && data.capabilities.canManageFleet ? <button onClick={() => setReschedule(audit)} type="button">Move</button> : null}
        {audit.status === "scheduled" && data.capabilities.canManageFleet ? <button className="danger" onClick={() => setCancelling(audit)} type="button">Remove</button> : null}
        {audit.status === "scheduled" && data.capabilities.canManageFleet ? <button onClick={() => setSwap(audit)} type="button"><ArrowLeftRight size={12} /> Swap</button> : null}
        {audit.evidence.length ? <button onClick={() => setInspect(audit)} type="button"><Eye size={12} /> Evidence</button> : null}
      </div>
    </> : data.capabilities.canManageFleet ? <button className="fc-schedule-slot" onClick={() => openSchedule(vehicleId, mode)} type="button"><Plus size={13} /> Schedule {modeMeta[mode].short.toLowerCase()}</button> : null}
  </div>;

  const firstDay = new Date(`${month}-01T12:00:00+05:30`);
  const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate();
  const calendarCells = [...Array(firstDay.getDay()).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];

  return <div className="fc-audits-workspace">
    <div className="fc-section-head fc-audit-head"><div><span className="fc-eyebrow">Twice-monthly assurance programme</span><h1>Vehicle audits</h1><p>Every active vehicle receives one virtual video review and one physical Fleet Manager inspection each month.</p></div><div className="fc-audit-head-actions"><button className="fc-button secondary" onClick={() => setEmailPreview(true)} type="button"><Mail size={16} /> Email preview</button>{data.capabilities.canManageFleet ? <button className="fc-button secondary" disabled={saving === "audit.auto-schedule"} onClick={() => act("audit.auto-schedule", { month })} type="button"><CalendarDays size={16} /> {saving === "audit.auto-schedule" ? "Planning…" : "Build smart schedule"}</button> : null}{data.capabilities.canManageFleet ? <button className="fc-button primary" onClick={() => openSchedule()} type="button"><Plus size={16} /> Schedule audits</button> : null}</div></div>
    {message ? <div className={`fc-inline-message ${message.tone}`}>{message.text}</div> : null}
    <div className="fc-audit-commandbar">
      <div className="fc-view-switch compact">
        <button className={view === "programme" ? "active" : ""} onClick={() => setView("programme")} type="button"><ClipboardCheck size={14} /> Programme</button>
        <button className={view === "calendar" ? "active" : ""} onClick={() => setView("calendar")} type="button"><CalendarDays size={14} /> Calendar</button>
        <button className={view === "history" ? "active" : ""} onClick={() => setView("history")} type="button"><ShieldCheck size={14} /> Audit log</button>
      </div>
      <div className="fc-month-switch"><button aria-label="Previous month" onClick={() => setMonth(monthShift(month, -1))} type="button"><ChevronLeft size={16} /></button><strong>{monthLabel(month)}</strong><button aria-label="Next month" onClick={() => setMonth(monthShift(month, 1))} type="button"><ChevronRight size={16} /></button></div>
      <FleetExportButtons compact report={{ title: "Vehicle audit programme", subtitle: monthLabel(month), fileName: `fleet-audit-programme-${month}`, headers: ["Vehicle", "Station", "Audit mode", "Scheduled date", "Status", "Score", "Evidence"], rows: monthAudits.map((audit) => [audit.vehicleNo, audit.stationCode, modeMeta[audit.auditMode].label, audit.scheduledFor, audit.status, audit.score, audit.evidenceCount]) }} />
    </div>
    <section className="fc-today-audits"><div className="fc-panel-head"><div><span className="fc-eyebrow">Today · {dateLabel(data.today)}</span><h2>Audit assignments</h2><p>Physical visits are grouped by station; virtual reviews can cover distant stations on the same day.</p></div><b>{todayAudits.length} due</b></div><div className="fc-today-audit-grid">{todayAudits.map((audit) => <article className={audit.auditMode} key={audit.id}><span>{audit.auditMode === "physical" ? <UserRoundCheck size={18} /> : <Video size={18} />}</span><div><small>{audit.auditMode === "physical" ? "Physical inspection" : "Virtual review"}</small><strong>{audit.vehicleNo}</strong><p>{audit.stationCode} · {audit.status.replaceAll("_", " ")}</p></div>{data.capabilities.canManageFleet ? <button onClick={() => openAudit(audit)} type="button">{audit.status === "scheduled" ? "Start" : "Continue"}</button> : null}</article>)}{!todayAudits.length ? <div className="fc-empty compact"><CalendarDays size={28} /><strong>No audit assigned today</strong><p>Use Build smart schedule to fill missing monthly slots.</p></div> : null}</div></section>
    <section className="fc-audit-kpis">
      <article className={coveredVehicles === activeVehicles.length && activeVehicles.length ? "good" : "warn"}><small>Fully covered vehicles</small><strong>{coveredVehicles}<span>/{activeVehicles.length}</span></strong><p>Both monthly audits planned</p></article>
      <article><small>Video reviews</small><strong>{videoCoverage}<span>/{activeVehicles.length}</span></strong><p>Remote evidence checks</p></article>
      <article><small>Physical inspections</small><strong>{physicalCoverage}<span>/{activeVehicles.length}</span></strong><p>In-person Fleet checks</p></article>
      <article className={missingSlots ? "bad" : "good"}><small>Open schedule slots</small><strong>{missingSlots}</strong><p>{open} scheduled · {completed} completed</p></article>
    </section>

    {view === "programme" ? <div className="fc-table-panel fc-audit-programme"><div className="fc-table-toolbar"><span>{activeVehicles.length} vehicles<small> · two required controls per month</small></span><small>Move an audit without losing its programme slot or history.</small></div><div className="fc-table-scroll"><table><thead><tr><th>Vehicle</th><th>Video review</th><th>Physical inspection</th><th>Monthly control</th></tr></thead><tbody>{activeVehicles.map((vehicle) => { const videoAudit = auditFor(vehicle.id, "video"); const physicalAudit = auditFor(vehicle.id, "physical"); const completePair = Boolean(videoAudit && physicalAudit); return <tr key={vehicle.id}><td data-label="Vehicle"><strong>{vehicle.vehicleNo}</strong><small className="fc-cell-note">{vehicle.stationCode} · {vehicle.model}</small>{data.auditSuggestions.find((item) => item.vehicleId === vehicle.id) ? <span className="fc-risk-flag"><AlertTriangle size={11} />Risk {data.auditSuggestions.find((item) => item.vehicleId === vehicle.id)?.riskScore}</span> : null}</td><td data-label="Video review">{renderAuditCell(videoAudit, vehicle.id, "video")}</td><td data-label="Physical inspection">{renderAuditCell(physicalAudit, vehicle.id, "physical")}</td><td data-label="Monthly control"><div className={`fc-monthly-control ${completePair ? "ready" : "attention"}`}>{completePair ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<div><strong>{completePair ? "Programme covered" : "Action required"}</strong><small>{completePair ? "Both audits are scheduled or complete" : `${videoAudit ? "Physical" : physicalAudit ? "Video" : "Both"} audit missing`}</small></div></div>{!completePair && data.capabilities.canManageFleet ? <button className="fc-row-action" onClick={() => openSchedule(vehicle.id, !videoAudit && !physicalAudit ? "both" : !videoAudit ? "video" : "physical")} type="button">Complete schedule <MoveRight size={13} /></button> : null}</td></tr>; })}</tbody></table></div>{!activeVehicles.length ? <div className="fc-empty"><ClipboardCheck size={34} /><strong>No vehicles in this scope</strong><p>Change the region, cluster or station filter.</p></div> : null}</div> : null}

    {view === "calendar" ? <section className="fc-audit-calendar"><div className="fc-calendar-weekdays">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="fc-calendar-grid">{calendarCells.map((day, index) => <div className={!day ? "empty" : ""} key={`${day}-${index}`}>{day ? <><b>{day}</b>{monthAudits.filter((audit) => Number(audit.scheduledFor.slice(8, 10)) === day).map((audit) => { const Icon = modeMeta[audit.auditMode].icon; return <button className={audit.auditMode} key={audit.id} onClick={() => ["scheduled","in_progress"].includes(audit.status) ? openAudit(audit) : setInspect(audit)} type="button"><Icon size={11} /><span>{audit.vehicleNo}</span><small>{audit.status === "scheduled" ? "Start audit" : audit.status === "in_progress" ? "Continue audit" : audit.status}</small></button>; })}</> : null}</div>)}</div></section> : null}

    {view === "history" ? <div className="fc-table-panel fc-audit-log"><div className="fc-table-toolbar"><span>{audits.length} audit records</span></div><div className="fc-table-scroll"><table><thead><tr><th>Date</th><th>Vehicle</th><th>Mode</th><th>Reason</th><th>Status</th><th>Score</th><th>Evidence</th><th>Action</th></tr></thead><tbody>{audits.map((audit) => <tr key={audit.id}><td data-label="Date">{dateLabel(audit.scheduledFor)}</td><td data-label="Vehicle"><strong>{audit.vehicleNo}</strong><small className="fc-cell-note">{audit.stationCode}</small></td><td data-label="Mode"><span className={`fc-audit-mode ${audit.auditMode}`}>{audit.auditMode === "video" ? <Video size={12} /> : <UserRoundCheck size={12} />}{modeMeta[audit.auditMode].label}</span></td><td data-label="Reason">{audit.scheduledReason}</td><td data-label="Status"><AuditState audit={audit} /></td><td data-label="Score">{audit.score == null ? "—" : `${audit.score}%`}</td><td data-label="Evidence">{audit.evidenceCount}</td><td data-label="Action"><div className="fc-inline-actions">{["scheduled","in_progress"].includes(audit.status) && data.capabilities.canManageFleet ? <button className="fc-start-audit" onClick={() => openAudit(audit)} type="button">{audit.status === "scheduled" ? "Start audit" : "Continue"}</button> : null}{["scheduled","in_progress"].includes(audit.status) && data.capabilities.canManageFleet ? <button onClick={() => setReschedule(audit)} type="button">Move</button> : null}{audit.status === "scheduled" && data.capabilities.canManageFleet ? <button className="danger" onClick={() => setCancelling(audit)} type="button">Remove</button> : null}{audit.evidence.length ? <button onClick={() => setInspect(audit)} type="button">View</button> : null}</div></td></tr>)}</tbody></table></div></div> : null}

    {schedule ? <div className="fc-modal-backdrop"><section className="fc-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setSchedule(null)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><CalendarDays size={23} /></span><div><small>Monthly audit programme</small><h2>Schedule vehicle audits</h2><p>Plan the video review and physical inspection as separate controls.</p></div></div><form className="fc-add-form" onSubmit={submitSchedule}><label className="full"><span>Vehicle</span><select name="vehicleId" onChange={(event) => setSchedule({ ...schedule, vehicleId: event.target.value })} required value={schedule.vehicleId}><option value="">Select vehicle</option>{activeVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNo} · {vehicle.stationCode} · {vehicle.model}</option>)}</select></label><label className="full"><span>Audit requirement</span><select name="auditMode" onChange={(event) => setSchedule({ ...schedule, mode: event.target.value as ScheduleDraft["mode"] })} value={schedule.mode}><option value="both">Both monthly audits</option><option value="video">Video review only</option><option value="physical">Physical inspection only</option></select></label>{schedule.mode !== "physical" ? <label><span>Video review date</span><input defaultValue={dates.video} max={`${month}-31`} min={`${month}-01`} name="videoDate" required type="date" /></label> : null}{schedule.mode !== "video" ? <label><span>Physical inspection date</span><input defaultValue={dates.physical} max={`${month}-31`} min={`${month}-01`} name="physicalDate" required type="date" /></label> : null}<label className="full"><span>Checklist template</span><select name="templateId"><option value="">Default routine audit</option>{data.auditTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.itemCount} checks</option>)}</select></label><label className="full"><span>Programme note</span><input defaultValue={schedule.reason} name="scheduledReason" required /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setSchedule(null)} type="button">Cancel</button><button className="fc-button primary" disabled={saving === "audit.schedule"} type="submit">{saving === "audit.schedule" ? "Scheduling…" : "Schedule audit"}</button></div></form></section></div> : null}

    {reschedule ? <div className="fc-modal-backdrop"><section className="fc-modal fc-reschedule-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setReschedule(null)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><MoveRight size={23} /></span><div><small>{reschedule.vehicleNo} · {modeMeta[reschedule.auditMode].label}</small><h2>Move scheduled audit</h2><p>The audit stays in the programme and its completion history is retained. Sundays and approved Fleet Manager leave are avoided by the daily scheduler.</p></div></div><form className="fc-add-form" onSubmit={submitReschedule}><label><span>Current date</span><input disabled value={reschedule.scheduledFor} /></label><label><span>New date</span><input defaultValue={reschedule.scheduledFor} name="scheduledFor" required type="date" /></label><label className="full"><span>Reason for moving</span><input name="rescheduleReason" placeholder="Inspector leave, vehicle at workshop, route conflict…" required /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setReschedule(null)} type="button">Keep current date</button><button className="fc-button primary" disabled={saving === "audit.reschedule"} type="submit">Move audit</button></div></form></section></div> : null}

    {swap ? <div className="fc-modal-backdrop"><section className="fc-modal fc-reschedule-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setSwap(null)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><ArrowLeftRight size={23} /></span><div><small>{swap.vehicleNo} · {dateLabel(swap.scheduledFor)}</small><h2>Swap audit dates</h2><p>Exchange dates with another scheduled audit while keeping both monthly audit slots intact.</p></div></div><form className="fc-add-form" onSubmit={async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await act("audit.swap", { auditId: swap.id, otherAuditId: form.get("otherAuditId") })) setSwap(null); }}><label className="full"><span>Swap with</span><select name="otherAuditId" required><option value="">Select scheduled audit</option>{monthAudits.filter((audit) => audit.id !== swap.id && audit.status === "scheduled").map((audit) => <option key={audit.id} value={audit.id}>{audit.vehicleNo} · {audit.stationCode} · {modeMeta[audit.auditMode].short} · {dateLabel(audit.scheduledFor)}</option>)}</select></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setSwap(null)} type="button">Cancel</button><button className="fc-button primary" disabled={saving === "audit.swap"} type="submit">Swap dates</button></div></form></section></div> : null}

    {cancelling ? <div className="fc-modal-backdrop"><section className="fc-modal fc-reschedule-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setCancelling(null)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><CalendarDays size={23} /></span><div><small>{cancelling.vehicleNo} · {modeMeta[cancelling.auditMode].label}</small><h2>Remove scheduled audit</h2><p>This opens the monthly slot again so it can be scheduled later. The cancellation remains in the audit log.</p></div></div><form className="fc-add-form" onSubmit={async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await act("audit.cancel", { auditId: cancelling.id, reason: form.get("reason") })) setCancelling(null); }}><label className="full"><span>Reason for removing</span><input name="reason" placeholder="Scheduled by mistake, vehicle unavailable…" required /></label><div className="fc-form-actions"><button className="fc-button secondary" onClick={() => setCancelling(null)} type="button">Keep audit</button><button className="fc-button danger" disabled={saving === "audit.cancel"} type="submit">Remove schedule</button></div></form></section></div> : null}

    {complete ? <div className="fc-modal-backdrop"><section className="fc-modal audit fc-conduct-audit"><button aria-label="Close" className="fc-modal-close" onClick={() => setComplete(null)} type="button"><X size={18} /></button>
      <div className="fc-modal-title"><span className="fc-vehicle-big">{complete.auditMode === "video" ? <Film size={23} /> : <UserRoundCheck size={23} />}</span><div><small>Audit in progress · {complete.stationCode} · {dateLabel(complete.scheduledFor)}</small><h2>{complete.vehicleNo} · {modeMeta[complete.auditMode].label}</h2><p>Complete every required check, attach outcome-specific evidence and submit the audit.</p></div></div>
      <form className="fc-audit-form" onSubmit={submitCompletion}>
        <div className="fc-audit-execution-head"><div><strong>{complete.auditMode === "physical" ? "Physical vehicle and driving checklist" : "Video vehicle checklist"}</strong><small>{checklistFor(complete).length} controls for this audit mode</small></div><span>{Object.values(responseDraft).filter(Boolean).length} answered</span></div>
        <AuditChecklist items={checklistFor(complete)} onResponse={(itemId, value) => setResponseDraft((current) => ({ ...current, [itemId]: value }))} responses={responseDraft} />
        {!checklistFor(complete).length ? <div className="fc-empty"><ListChecks size={32} /><strong>No checklist is configured for this audit</strong><p>Open Masters → Vehicle Audit and add controls for {complete.auditMode} audits.</p></div> : null}
        <div className="fc-audit-fields"><label><span>Odometer km</span><input min="0" name="odometerKm" type="number" /></label>{complete.auditMode === "video" ? <label className="full"><span>Complete walk-around video link *</span><input name="walkAroundVideoUrl" placeholder="Paste a shareable video link" required type="url" /></label> : null}<label className="full"><span>Audit summary</span><textarea name="summary" placeholder="Overall condition and key observations" rows={3} /></label><label><span>Finding category</span><input name="findingCategory" placeholder="Tyres, body, documents…" /></label><label><span>Severity</span><select name="severity"><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option><option value="critical">Critical</option></select></label><label className="full"><span>Finding</span><textarea name="finding" placeholder="Describe the issue found" rows={2} /></label><label className="full"><span>Required action</span><input name="actionRequired" placeholder="Repair, replace, upload document…" /></label><label><span>Expected completion</span><input name="expectedCompletionDate" type="date" /></label><label className="fc-toggle"><input defaultChecked={data.settings.auditEmailEnabled} name="sendEmail" type="checkbox" /><span>Email findings to station and approvers</span></label></div>
        <div className="fc-form-actions sticky"><button className="fc-button secondary" onClick={() => setComplete(null)} type="button">Close</button><button className="fc-button primary" disabled={saving === "audit.complete" || !checklistFor(complete).length} type="submit">{saving === "audit.complete" ? "Submitting…" : "Complete audit"}</button></div>
      </form>
    </section></div> : null}

    {inspect ? <div className="fc-modal-backdrop"><section className="fc-modal fc-evidence-viewer"><button aria-label="Close" className="fc-modal-close" onClick={() => setInspect(null)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><LinkIcon size={23} /></span><div><small>{inspect.vehicleNo} · {modeMeta[inspect.auditMode].label}</small><h2>Audit evidence</h2><p>Shareable evidence links remain attached to this audit history.</p></div></div><div className="fc-audit-evidence-list">{inspect.evidence.map((item) => <a href={item.mediaUrl} key={item.id} rel="noreferrer" target="_blank"><span>{item.mediaType === "video" ? <Video size={16} /> : <LinkIcon size={16} />}</span><div><strong>{item.caption || `${item.mediaType} evidence`}</strong><small>{item.mediaType} · opens in a new tab</small></div><Eye size={15} /></a>)}{!inspect.evidence.length ? <div className="fc-empty compact"><Film size={30} /><strong>No evidence attached</strong></div> : null}</div></section></div> : null}
    {emailPreview ? <div className="fc-modal-backdrop"><section className="fc-modal wide fc-audit-email-modal"><button aria-label="Close" className="fc-modal-close" onClick={() => setEmailPreview(false)} type="button"><X size={18} /></button><div className="fc-modal-title"><span className="fc-vehicle-big"><Mail size={23} /></span><div><small>Actual configurable audit email design</small><h2>Audit completion email</h2><p>Sent once after completion to the station mailbox, station manager and configured Fleet approvers.</p></div></div><div className="fc-audit-email-preview" style={{ "--audit-primary": data.settings.auditProgramme.primaryColor, "--audit-accent": data.settings.auditProgramme.accentColor, "--audit-alert": data.settings.auditProgramme.alertColor } as React.CSSProperties}><header><div><small>Vehicle assurance · KGQA</small><h2>{data.settings.auditProgramme.emailTitle}</h2><p>07 Oct 2026 · Physical inspection</p></div><b>DropX Fleet</b></header><section><div className="fc-audit-mail-summary"><div><small>Vehicle</small><strong>KL11CC2758</strong><p>Mahindra Jeeto · KGQA</p></div><span>Attention required</span></div><blockquote><b>Inspector summary</b><p>Vehicle is operational. Front-left tyre wear and first-aid replenishment require follow-up.</p></blockquote><h3>Major findings and action</h3><table><thead><tr><th>Area</th><th>Finding</th><th>Required action</th></tr></thead><tbody><tr><td><b>Tyres</b><small>High</small></td><td>Front-left tyre tread is below the configured safe limit.</td><td>Replace before next route<br /><small>Due 09 Oct 2026</small></td></tr><tr><td><b>Safety</b><small>Medium</small></td><td>Two first-aid items are missing.</td><td>Replenish at station</td></tr></tbody></table><h3>Evidence and attachments</h3><div className="fc-audit-mail-evidence"><span>Tyre photo ↗</span><span>Vehicle walk-around video ↗</span></div></section></div></section></div> : null}
  </div>;
}
