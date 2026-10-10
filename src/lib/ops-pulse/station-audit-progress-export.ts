import * as XLSX from "xlsx";
import {
  auditProgress,
  summarizeAuditProgress,
  type AuditProgressRow,
} from "./station-audit-progress";

export function auditWorkbookSheet(rows: Record<string, unknown>[]) {
  // Excel rejects a whole workbook when even one history/remarks cell exceeds
  // 32,767 UTF-16 units. Preserve every character in labelled adjacent columns.
  const safeRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([key, value]) => {
        if (typeof value !== "string" || value.length <= 32767)
          return [[key, value]];
        const parts: [string, unknown][] = [];
        for (let offset = 0; offset < value.length; ) {
          let end = Math.min(offset + 32000, value.length);
          if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]))
            end--;
          parts.push([
            parts.length ? `${key} (continued ${parts.length + 1})` : key,
            value.slice(offset, end),
          ]);
          offset = end;
        }
        return parts;
      }),
    ),
  );
  const keys = [...new Set(safeRows.flatMap((row) => Object.keys(row)))];
  const sheet = XLSX.utils.json_to_sheet(
    safeRows.length ? safeRows : [{ Result: "No records for this selection" }],
    { header: keys.length ? keys : ["Result"] },
  );
  sheet["!autofilter"] = { ref: sheet["!ref"] || "A1:A2" };
  sheet["!cols"] = keys.map((key) => ({
    wch: Math.min(48, Math.max(14, key.length + 3)),
  }));
  const percentage = keys.indexOf("Completion %");
  if (percentage >= 0)
    rows.forEach((_, index) => {
      const cell =
        sheet[XLSX.utils.encode_cell({ r: index + 1, c: percentage })];
      if (cell && cell.t === "n") cell.z = "0.0%";
    });
  return sheet;
}

type ExportAudit = AuditProgressRow & {
  id: string;
  location_id: string;
  assigned_to: string | null;
  assignment_verified: boolean;
  assigned_name: string | null;
  audit_number: string;
};
export function appendAuditProgressSummary(
  book: XLSX.WorkBook,
  audits: ExportAudit[],
  context: {
    from: string;
    to: string;
    now: number;
    filters: string;
    stations: {
      id: string;
      station_code: string;
      station_name?: string | null;
      city?: string | null;
    }[];
    auditorName: (audit: ExportAudit) => string;
    register: Record<string, unknown>[];
  },
) {
  const summary = (rows: ExportAudit[]) => {
    const v = summarizeAuditProgress(rows, context.now);
    return {
      "Total audits": v.total,
      "Completed & closed": v.completed,
      "Not completed": v.incomplete,
      "Completion %": v.completionRate,
      "Fieldwork submitted": v.submitted,
      "Not submitted": v.notSubmitted,
      "Overdue audits": v.overdue,
      "Not yet due": v.upcoming,
      "Station response pending": v.responsePending,
      "Overdue station responses": v.responseOverdue,
      "Review pending": v.waitingReview,
    };
  };
  const append = (name: string, rows: Record<string, unknown>[]) =>
    XLSX.utils.book_append_sheet(book, auditWorkbookSheet(rows), name);
  append("Overview", [
    {
      "From date (IST)": context.from,
      "To date (IST)": context.to,
      "Status as of (IST)": new Date(context.now).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      }),
      ...summary(audits),
      Filters: context.filters,
      "Date basis":
        "Scheduled date, inclusive. Current status at export; not a historical status snapshot.",
      "Completion definition":
        "Completed / closed workflow. Fieldwork submission does not imply final closure.",
      Scope:
        "Scheduled records only. Unscheduled programme slots are in Monthly plan; future scheduled audits are not overdue.",
      "Long text":
        "Text exceeding Excel's cell limit continues in adjacent columns labelled continued 2, continued 3, etc. No text is discarded.",
    },
  ]);
  append(
    "Station summary",
    context.stations.map((station) => {
      const rows = audits.filter((a) => a.location_id === station.id);
      return {
        Station: station.station_code,
        "Station name": station.station_name || station.city || "",
        ...summary(rows),
        Note: rows.length
          ? ""
          : "No audits match the selected dates and filters",
      };
    }),
  );
  // Never merge different employees merely because their display names match.
  const grouped = new Map<string, ExportAudit[]>();
  for (const audit of audits) {
    const key =
      audit.assignment_verified && audit.assigned_to
        ? audit.assigned_to
        : `unverified:${audit.assigned_name || "unassigned"}`;
    grouped.set(key, [...(grouped.get(key) || []), audit]);
  }
  append(
    "Auditor summary",
    [...grouped].map(([key, rows]) => ({
      "Assigned auditor": context.auditorName(rows[0]),
      "Assignment verified": key.startsWith("unverified:") ? "No" : "Yes",
      ...summary(rows),
    })),
  );
  append(
    "Follow-up",
    audits.flatMap((audit, index) => {
      const p = auditProgress(audit, context.now);
      return p.completed
        ? []
        : [
            {
              ...context.register[index],
              "Follow-up remarks (team to complete)": "",
              "Committed completion date": "",
            },
          ];
    }),
  );
}
