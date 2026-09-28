"use client";
import { useState } from "react";
import { Download, Search } from "lucide-react";
import { shiftFilters, matchesShift, type ShiftAttendance, type ShiftFilter } from "@/lib/shift-attendance-view";
export function ShiftAttendanceTools({ people, filter, search, onFilter, onSearch, exportUrl }: {
  people: ShiftAttendance[]; filter: ShiftFilter; search: string;
  onFilter: (value: ShiftFilter) => void; onSearch: (value: string) => void; exportUrl?: string;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function download() {
    if (!exportUrl) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${exportUrl}&status=${encodeURIComponent(filter)}&search=${encodeURIComponent(search)}`);
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Download failed"); }
      const blob = await response.blob(), url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "shift-attendance.xlsx";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed. Please retry."); }
    finally { setBusy(false); }
  }
  return <div style={{ padding: "10px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "white", border: "1px solid #e2e8f0", borderRadius: 12 }}>
    <label style={{ display: "flex", gap: 6, alignItems: "center", flex: "1 1 180px" }}><Search size={15} aria-hidden="true" />
      <input aria-label="Search shift attendance" placeholder="Name or People ID" value={search} onChange={e => onSearch(e.target.value)} style={{ width: "100%", minWidth: 0 }} />
    </label>
    <select aria-label="Attendance status" value={filter} onChange={e => onFilter(e.target.value as ShiftFilter)} style={{ width: "auto", minWidth: 180 }}>
      {shiftFilters.map(([value, label]) => <option key={value} value={value}>{label} ({people.filter(p => matchesShift(p, value, search)).length})</option>)}
    </select>
    {(filter !== "all" || search) && <button type="button" onClick={() => { onFilter("all"); onSearch(""); }}>Reset</button>}
    <button type="button" disabled={!exportUrl || busy} title={!exportUrl ? "Attendance export permission required" : "Download matching rows for this date and location"} onClick={download}><Download size={14} /> {busy ? "Downloading…" : "Excel"}</button>
    {error && <span role="alert" style={{ color: "#b91c1c", width: "100%", fontSize: 12 }}>{error}</span>}
  </div>;
}

