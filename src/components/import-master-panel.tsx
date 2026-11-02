"use client";
import { ReportTable } from "@/components/report-table";


import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ReportImportMaster, reportSchedule, weekdayNames } from "@/lib/report-import-master";

const empty = {
  id: "", source_code: "", name: "", description: "", file_types: "xlsx", day_offset: 0,
  upload_time: "", frequency: "daily", weekday: "", parser_type: "generic_table",
  dedupe_fields: "", is_active: true, requires_station: false, station_scope: "none",
  requires_report_date: false, report_date_label: "Data date", date_default_offset: 0
};

export function ImportMasterPanel({ reports }: { reports: ReportImportMaster[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState({ ...empty });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function edit(report?: ReportImportMaster) {
    setEditing(report ? {
      ...report,
      description: report.description ?? "",
      file_types: report.file_types.join(", "),
      upload_time: report.upload_time?.slice(0, 5) ?? "",
      weekday: report.weekday === null ? "" : String(report.weekday),
      dedupe_fields: report.dedupe_fields.join(", "),
      report_date_label: report.report_date_label ?? "Data date"
    } : { ...empty });
    setMessage(null);
    setError(null);
  }

  function save() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/import-master", {
        method: editing.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return setError(result.error ?? "Unable to save report.");
      setMessage(editing.id ? "Report updated." : "Report added.");
      setEditing({ ...empty });
      router.refresh();
    });
  }

  function remove(report: ReportImportMaster) {
    if (!window.confirm(`Delete ${report.name} from Import Master? Existing imported data will be retained.`)) return;
    startTransition(async () => {
      const response = await fetch(`/api/import-master?id=${encodeURIComponent(report.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return setError(result.error ?? "Unable to delete report.");
      setMessage("Report deleted. Existing imported rows were retained.");
      router.refresh();
    });
  }

  const set = (field: string, value: string | boolean | number) => setEditing((current) => ({ ...current, [field]: value }));

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Import Master</h2>
          <p className="subtle">Controls the upload menu, accepted files, timing, cadence, parser and duplicate keys.</p>
        </div>
        <button className="button secondary compact" onClick={() => edit()} type="button">Add report</button>
      </div>
      <div className="table-wrap">
        <ReportTable>
          <thead><tr><th>Report</th><th>Schedule</th><th>File type</th><th>Parser</th><th>Duplicate keys</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id}>
                <td><strong>{report.name}</strong><div className="subtle">{report.description}</div></td>
                <td>{reportSchedule(report)}</td>
                <td>{report.file_types.map((item) => `.${item}`).join(", ")}</td>
                <td>{report.parser_type}</td>
                <td>{report.dedupe_fields.join(", ") || "row hash"}</td>
                <td>{report.is_active ? "Active" : "Inactive"}</td>
                <td><div className="toolbar-actions"><button className="button secondary compact" onClick={() => edit(report)} type="button">Edit</button><button className="button danger compact" onClick={() => remove(report)} type="button">Delete</button></div></td>
              </tr>
            ))}
          </tbody>
        </ReportTable>
      </div>

      <div className="panel-body stacked" style={{ borderTop: "1px solid var(--border)" }}>
        <h3>{editing.id ? `Edit ${editing.name}` : "Add report"}</h3>
        <div className="form-grid three">
          <label><span>Name</span><input className="field" value={editing.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label><span>Source code</span><input className="field" disabled={Boolean(editing.id)} value={editing.source_code} onChange={(e) => set("source_code", e.target.value)} /></label>
          <label><span>File types</span><input className="field" placeholder="pdf, xlsx" value={editing.file_types} onChange={(e) => set("file_types", e.target.value)} /></label>
          <label><span>Frequency</span><select className="select" value={editing.frequency} onChange={(e) => set("frequency", e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="adhoc">Ad hoc</option></select></label>
          <label><span>Report day</span><select className="select" value={editing.day_offset} onChange={(e) => set("day_offset", Number(e.target.value))}><option value={-1}>D-1</option><option value={0}>D0</option><option value={1}>D+1</option></select></label>
          <label><span>Upload time</span><input className="field" type="time" value={editing.upload_time} onChange={(e) => set("upload_time", e.target.value)} /></label>
          {editing.frequency === "weekly" ? <label><span>Weekday</span><select className="select" value={editing.weekday} onChange={(e) => set("weekday", e.target.value)}><option value="">Select</option>{weekdayNames.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label> : null}
          <label><span>Parser</span><input className="field" value={editing.parser_type} onChange={(e) => set("parser_type", e.target.value)} /></label>
          <label><span>Duplicate keys</span><input className="field" value={editing.dedupe_fields} onChange={(e) => set("dedupe_fields", e.target.value)} /></label>
          <label><span>Station field</span><select className="select" value={editing.requires_station ? editing.station_scope : "none"} onChange={(e) => { set("requires_station", e.target.value !== "none"); set("station_scope", e.target.value); }}><option value="none">Do not show</option><option value="all">All permitted stations</option><option value="amazon_dsp_xpt">Amazon DSP / XPT only</option></select></label>
          <label><span>Date field</span><select className="select" value={editing.requires_report_date ? "show" : "none"} onChange={(e) => set("requires_report_date", e.target.value === "show")}><option value="none">Do not show</option><option value="show">Show date selector</option></select></label>
          {editing.requires_report_date ? <label><span>Date label</span><input className="field" value={editing.report_date_label} onChange={(e) => set("report_date_label", e.target.value)} /></label> : null}
          {editing.requires_report_date ? <label><span>Default date</span><select className="select" value={editing.date_default_offset} onChange={(e) => set("date_default_offset", Number(e.target.value))}><option value={-1}>Yesterday</option><option value={0}>Today</option><option value={1}>Tomorrow</option></select></label> : null}
          <label style={{ gridColumn: "span 3" }}><span>Description</span><input className="field" value={editing.description} onChange={(e) => set("description", e.target.value)} /></label>
        </div>
        <label><input checked={editing.is_active} onChange={(e) => set("is_active", e.target.checked)} type="checkbox" /> Active in upload menu</label>
        <div className="toolbar-actions"><button className={`button ${pending ? "loading" : ""}`} disabled={pending} onClick={save} type="button">Save report</button>{editing.id ? <button className="button secondary" onClick={() => edit()} type="button">Cancel</button> : null}</div>
        {message ? <div className="message-panel success"><strong>{message}</strong></div> : null}
        {error ? <div className="message-panel error"><strong>{error}</strong></div> : null}
      </div>
    </section>
  );
}
