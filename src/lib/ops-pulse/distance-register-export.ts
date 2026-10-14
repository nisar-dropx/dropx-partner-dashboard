import * as XLSX from "xlsx";
import { distanceMethods, distanceStatus, filterDistanceEntries, groupDistanceAssociates, type DistanceEntry, type DistanceViewFilters } from "./distance-register.ts";
import { routePendingLabel } from "../workforce-route-distance.ts";

export function distanceWorkbookBytes(rows: DistanceEntry[], filters: DistanceViewFilters): ArrayBuffer {
  const selected = filterDistanceEntries(rows, filters);
  const associates = groupDistanceAssociates(selected);
  const workbook = XLSX.utils.book_new();
  const add = (name: string, header: string[], records: (string | number | null)[][], numeric: number[] = []) => {
    const sheet = XLSX.utils.aoa_to_sheet([header, ...records]);
    sheet["!cols"] = header.map((label, column) => ({ wch: Math.min(48, Math.max(16, label.length + 2, ...records.map((row) => String(row[column] ?? "").length + 2))) }));
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: records.length, c: header.length - 1 } }) };
    for (let r = 1; r <= records.length; r++) for (const c of numeric) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t === "n") cell.z = "#,##0.00";
    }
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  add("Associate summary", ["Associate", "Station(s)", "Amazon ID(s)", "Mapped DropX ID(s)", "LSC Driver ID(s)", "Days", "Pending days", "Recorded distance (km)", "Recorded fuel (INR)", "Coverage"],
    associates.map((a) => [a.name, a.stations.join(", "), a.amazonIds.join(", "), a.dropxIds.join(", "), a.transporterIds.join(", "), a.days, a.pendingDays, a.km, a.fuel, a.pendingDays ? (a.km === null ? "Pending" : "Partial total") : "All days ready"]), [7, 8]);
  add("Daily details", ["Date", "Station", "Region", "Cluster", "Associate", "Amazon ID", "Mapped DropX ID", "LSC Driver ID", "Distance (km)", "Rate (INR/km)", "Fuel (INR)", "Status", "Source", "Pending reason", "Station to first stop (km)", "Between stops (km)", "Return to station (km)", "Scan count", "Updated (UTC)"],
    associates.flatMap((a) => a.rows.map((r) => [r.date, r.station, r.region, r.cluster, r.name, r.amazonId, r.dropxId, r.transporterId, r.km, r.rate, r.fuel, distanceStatus(r), distanceMethods[r.method] || r.method,
      r.status === "ready" ? "" : r.reason === "input_conflict" ? "Conflicting kilometre inputs or overlapping mappings" : routePendingLabel(r.reason), r.departureKm, r.deliveryKm, r.returnKm, r.scans, r.updatedAt || ""])), [8, 9, 10, 14, 15, 16]);
  add("Applied filters", ["Filter", "Value"], [
    ["From", filters.from], ["To", filters.to], ["Stations", filters.stations.join(", ") || "All permitted stations"],
    ["Regions", filters.regions.join(", ") || "All"], ["Clusters", filters.clusters.join(", ") || "All"],
    ["Statuses", filters.statuses.join(", ") || "All"], ["Sources", filters.methods.join(", ") || "All"],
    ["Search", filters.query || "None"], ["Associates", associates.length], ["Daily records", selected.length],
    ["Basis", "Same filtered snapshot as the register; all pages included. Pending distance and fuel are blank, never zero. Partial totals include recorded days only."],
  ]);
  return XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
}
