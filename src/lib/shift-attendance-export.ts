import * as XLSX from "xlsx";
import { matchesShift, shiftLabel, type ShiftAttendance } from "@/lib/shift-attendance-view";
export function shiftAttendanceWorkbook(people: Array<ShiftAttendance & { designation: string; locationId: string | null }>, date: string, locations: Map<string, string>, status: string, search: string, shift = "") {
  const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "";
  const rows = people.filter(p => matchesShift(p, status, search)).filter(p => !shift || (shift === "__week_off__" ? !p.today.shiftName : p.today.shiftName === shift)).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({
    Date: date, Location: locations.get(p.locationId ?? "") ?? "", "People ID": p.code, Name: p.name, Designation: p.designation,
    Roster: p.today.shiftName ?? p.today.rosterDayType ?? p.today.rosterSetupLabel ?? "No approved roster",
    Status: shiftLabel(p), "Work mode": p.today.workMode ?? "Onsite",
    "Approved leave": p.today.approvedLeave ? "Yes" : "No", "WFH credit": p.today.wfhState ?? "",
    "IN (IST)": time(p.today.inTime), "OUT (IST)": time(p.today.outTime), "Recorded / credited minutes": p.today.workMinutes,
    "Late in minutes": matchesShift(p, "late") ? p.today.lateMinutes : 0,
    "Early out minutes": matchesShift(p, "early") ? p.today.earlyMinutes ?? 0 : 0,
    "Missing punch": matchesShift(p, "single") ? "Yes" : "No"
  }));
  const wb = XLSX.utils.book_new();
  const header = ["Date","Location","People ID","Name","Designation","Roster","Status","Work mode","Approved leave","WFH credit","IN (IST)","OUT (IST)","Recorded / credited minutes","Late in minutes","Early out minutes","Missing punch"];
  const sheet = XLSX.utils.json_to_sheet(rows, { header });
  sheet["!cols"] = header.map(h => ({ wch: ["Name","Roster","Status"].includes(h) ? 30 : 22 }));
  sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1:P1" };
  XLSX.utils.book_append_sheet(wb, sheet, "Shift attendance");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
export function shiftExportResponse(bytes: Uint8Array, date: string) {
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="shift-attendance-${date}.xlsx"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
