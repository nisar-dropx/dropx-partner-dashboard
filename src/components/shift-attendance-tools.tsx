"use client";

import { Download, Search } from "lucide-react";
import { shiftFilters, matchesShift, type ShiftAttendance, type ShiftFilter } from "@/lib/shift-attendance-view";
export function ShiftAttendanceTools({ people, filter, search, onFilter, onSearch, exportUrl }: {
  people: ShiftAttendance[]; filter: ShiftFilter; search: string;
  onFilter: (value: ShiftFilter) => void; onSearch: (value: string) => void; exportUrl?: string;
}) {
  const downloadUrl = exportUrl ? `${exportUrl}&status=${encodeURIComponent(filter)}&search=${encodeURIComponent(search)}` : undefined;
  const downloadStyle = { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "6px 12px", border: "1px solid #dbe2ea", borderRadius: 8, background: "#fff", color: !exportUrl ? "#98a2b3" : "#344054", fontSize: 12, fontWeight: 600, textDecoration: "none" };
  return <div style={{ padding: "10px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "white", border: "1px solid #e2e8f0", borderRadius: 12 }}>
    <label style={{ display: "flex", gap: 6, alignItems: "center", flex: "1 1 240px", maxWidth: 480 }}><Search size={15} aria-hidden="true" />
      <input aria-label="Search shift attendance" placeholder="Name or People ID" value={search} onChange={e => onSearch(e.target.value)} style={{ width: "100%", minWidth: 0, height: 34, padding: "6px 10px", border: "1px solid #dbe2ea", borderRadius: 8, fontSize: 12, background: "#fff", color: "#344054" }} />
    </label>
    <select aria-label="Attendance status" value={filter} onChange={e => onFilter(e.target.value as ShiftFilter)} style={{ width: "auto", minWidth: 180, height: 34, padding: "6px 10px", border: "1px solid #dbe2ea", borderRadius: 8, fontSize: 12, background: "#fff", color: "#344054" }}>
      {shiftFilters.map(([value, label]) => <option key={value} value={value}>{label} ({people.filter(p => matchesShift(p, value, search)).length})</option>)}
    </select>
    {(filter !== "all" || search) && <button type="button" style={{ height: 34, padding: "6px 12px", border: "1px solid #dbe2ea", borderRadius: 8, background: "#fff", fontSize: 12 }} onClick={() => { onFilter("all"); onSearch(""); }}>Reset</button>}
    {downloadUrl ? <a style={downloadStyle} href={downloadUrl} download title="Download matching rows for this date and location"><Download size={14} />Excel</a>
      : <button type="button" style={downloadStyle} disabled title="Attendance export permission required"><Download size={14} />Excel</button>}
  </div>;
}
