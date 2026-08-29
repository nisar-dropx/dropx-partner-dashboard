import * as XLSX from "xlsx";
import {
  type AttendanceReportRow,
  type AttendanceReportType,
  istDate,
  loadAttendanceReportRows
} from "@/lib/biometric/attendance";
import { filterAttendanceReportRows } from "@/lib/biometric/attendance-report-filters";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type ReportMode = "monthly" | "periodic";
type SortMode = "workforce_type" | "designation" | "location";

type ReportBuild = {
  aoa: string[][];
  merges: XLSX.Range[];
  widths: number[];
};

const inOutPairs = 8;

const reportLabels: Record<AttendanceReportType, string> = {
  absent: "Daily Absent Report",
  early_out: "Daily Early OUT Report",
  in_out: "Daily IN/OUT Report",
  late_in: "Daily Late IN Report",
  mis_punch: "Daily Mis Punch Report",
  performance: "Daily Performance Report",
  present: "Daily Present Report"
};

function safeMode(value: string | null): ReportMode {
  return value === "monthly" ? "monthly" : "periodic";
}

function safeSort(value: string | null): SortMode {
  return value === "designation" || value === "location" ? value : "workforce_type";
}

function safeReportType(value: string | null): AttendanceReportType {
  const allowed: AttendanceReportType[] = ["performance", "in_out", "present", "absent", "late_in", "early_out", "mis_punch"];
  return allowed.includes(value as AttendanceReportType) ? value as AttendanceReportType : "performance";
}

function safeDate(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : istDate(new Date());
}

function safeMonth(value: string | null) {
  return value && /^\d{4}-\d{2}$/.test(value) ? value : istDate(new Date()).slice(0, 7);
}

function monthBounds(month: string) {
  const [year, rawMonth] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, rawMonth - 1, 1));
  const end = new Date(Date.UTC(year, rawMonth, 0));
  return {
    fromDate: start.toISOString().slice(0, 10),
    label: month,
    toDate: end.toISOString().slice(0, 10)
  };
}

function dateParts(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { day, month, year };
}

function displayDate(value: string) {
  const { day, month, year } = dateParts(value);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

function displayMonth(month: string) {
  const [year, rawMonth] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, rawMonth - 1, 1)))
    .replace(" ", "-");
}

function reportTitle(mode: ReportMode, reportType: AttendanceReportType) {
  const base = reportLabels[reportType].replace(/^Daily /, "");
  return `${mode === "monthly" ? "Monthly" : "Date Range"} ${base}`;
}

function merge(startRow: number, startCol: number, endRow: number, endCol: number): XLSX.Range {
  return { s: { r: startRow, c: startCol }, e: { r: endRow, c: endCol } };
}

function blank(width: number) {
  return Array.from({ length: width }, () => "");
}

function normalizedRange(fromDate: string, toDate: string) {
  return fromDate <= toDate ? { fromDate, toDate } : { fromDate: toDate, toDate: fromDate };
}

function groupBy<T>(items: T[], keyer: (item: T) => string) {
  return items.reduce((map, item) => {
    const key = keyer(item) || "-";
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
    return map;
  }, new Map<string, T[]>());
}


function groupLabel(sort: SortMode) {
  if (sort === "designation") return "Desg. Name";
  if (sort === "location") return "Location";
  return "Workforce Type";
}

function groupKey(row: AttendanceReportRow, sort: SortMode) {
  if (sort === "designation") return row.designation || "-";
  if (sort === "location") return row.location || "-";
  return row.workerType || "-";
}

function totals(rows: AttendanceReportRow[]) {
  return {
    absent: rows.filter((row) => row.attendanceStatus === "Absent").length,
    late: rows.filter((row) => row.lateMinutes > 0).length,
    misPunch: rows.filter((row) => row.punchCount % 2 === 1 || row.remark.toLowerCase().includes("single") || row.remark.toLowerCase().includes("missing")).length,
    present: rows.filter((row) => row.status === "P").length
  };
}

function label(row: AttendanceReportRow, name: string) {
  return row.labels[name] && row.labels[name] !== "--:--" ? row.labels[name] : "";
}

function scheduleLabel(row: AttendanceReportRow) {
  return row.scheduledStart === "--:--" ? "Unassigned" : `${row.scheduledStart}-${row.scheduledEnd}`;
}

function varianceLabel(minutesValue: number, fallback = "00:00") {
  return minutesValue > 0 ? duration(minutesValue) : fallback;
}

function inOutHeader() {
  const columns = ["Date", "Empcode", "Name", "Workforce", "Designation", "Location", "Shift", "Scheduled", "INTime"];
  for (let index = 1; index <= inOutPairs; index += 1) {
    columns.push(`Out${index}`);
  }
  columns.push("OUTTime", "Work", "Day Status", "Late In", "Early Out", "Remark");
  return columns;
}

function inOutRow(row: AttendanceReportRow) {
  const values = [displayDate(row.punchDate), row.workerCode, row.workerName, row.workerType, row.designation, row.location, row.shiftName, scheduleLabel(row), label(row, "In1") || row.inTime];
  for (let index = 1; index <= inOutPairs; index += 1) {
    values.push(label(row, `Out${index}`));
  }
  values.push(row.outTime, row.workHours, row.attendanceStatus, varianceLabel(row.lateMinutes), varianceLabel(row.earlyOutMinutes), row.remark || "-");
  return values;
}

function performanceHeader(reportType: AttendanceReportType) {
  const people = ["Date", "Empcode", "Name", "Workforce", "Designation", "Location", "Shift", "Scheduled"];
  if (reportType === "absent") return [...people, "IN Time", "Out Time", "Work", "Day Status", "Remark"];
  if (reportType === "late_in") return [...people, "IN Time", "Late IN", "Day Status"];
  if (reportType === "early_out") return [...people, "IN Time", "OUT Time", "Early Out", "Day Status"];
  if (reportType === "mis_punch") return [...people, "INTime", "OUTTime", "Punches", "Day Status", "Remark"];
  return [...people, "INTime", "OUTTime", "Work", "Day Status", "Late In", "Early Out", "Punches", "Remark"];
}

function performanceRow(row: AttendanceReportRow, reportType: AttendanceReportType) {
  const people = [displayDate(row.punchDate), row.workerCode, row.workerName, row.workerType, row.designation, row.location, row.shiftName, scheduleLabel(row)];
  if (reportType === "absent") return [...people, row.inTime, row.outTime, row.workHours, row.attendanceStatus, row.remark || "-"];
  if (reportType === "late_in") return [...people, row.inTime, varianceLabel(row.lateMinutes), row.attendanceStatus];
  if (reportType === "early_out") return [...people, row.inTime, row.outTime, varianceLabel(row.earlyOutMinutes), row.attendanceStatus];
  if (reportType === "mis_punch") return [...people, row.inTime, row.outTime, String(row.punchCount), row.attendanceStatus, row.remark || "-"];
  return [...people, row.inTime, row.outTime, row.workHours, row.attendanceStatus, varianceLabel(row.lateMinutes), varianceLabel(row.earlyOutMinutes), String(row.punchCount), row.remark || "-"];
}

function dailyBuild(title: string, dateLabel: string, rows: AttendanceReportRow[], reportType: AttendanceReportType, sort: SortMode, companyName: string): ReportBuild {
  const isInOut = reportType === "in_out";
  const header = isInOut ? inOutHeader() : performanceHeader(reportType);
  const width = header.length;
  const aoa: string[][] = [];
  const merges: XLSX.Range[] = [];
  aoa.push([title, ...blank(Math.max(0, width - 4)), "Date :-", dateLabel]);
  merges.push(merge(0, 0, 0, Math.min(3, width - 1)));
  aoa.push([companyName, ...blank(width - 1)]);
  merges.push(merge(1, 0, 1, width - 1));

  const groups = groupBy(rows, (row) => groupKey(row, sort));
  Array.from(groups.entries()).forEach(([group, groupRows]) => {
    const groupTotals = totals(groupRows);
    const summary = `Total Present :- ${groupTotals.present}    Total Absent :- ${groupTotals.absent}    Total Late In :- ${groupTotals.late}`;
    aoa.push([groupLabel(sort), group, summary, ...blank(Math.max(0, width - 3))]);
    merges.push(merge(aoa.length - 1, 2, aoa.length - 1, width - 1));
    aoa.push(header);
    groupRows.forEach((row) => aoa.push(isInOut ? inOutRow(row) : performanceRow(row, reportType)));
  });

  if (!rows.length) {
    aoa.push([groupLabel(sort), "No data", "No punches available for this filter.", ...blank(Math.max(0, width - 3))]);
    merges.push(merge(aoa.length - 1, 2, aoa.length - 1, width - 1));
    aoa.push(header);
  }

  const allTotals = totals(rows);
  aoa.push(["Total For Whole Company", "", `Total Present:- ${allTotals.present}    Total Absent:- ${allTotals.absent}    Total Late In:- ${allTotals.late}`, ...blank(Math.max(0, width - 3))]);
  merges.push(merge(aoa.length - 1, 0, aoa.length - 1, 1));
  merges.push(merge(aoa.length - 1, 2, aoa.length - 1, width - 1));
  const widths = header.map((column) => {
    if (column === "Name") return 24;
    if (column === "Designation" || column === "Workforce") return 20;
    if (column === "Remark") return 22;
    if (column === "Shift" || column === "Scheduled") return 14;
    if (column === "Date" || column === "Empcode" || column === "Day Status") return 13;
    return 9;
  });
  return { aoa, merges, widths };
}

function dateRange(fromDate: string, toDate: string) {
  const dates: string[] = [];
  const current = new Date(`${fromDate}T00:00:00.000Z`);
  const last = new Date(`${toDate}T00:00:00.000Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function minutes(value: string) {
  const [hours, mins] = value.split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(mins) ? hours * 60 + mins : 0;
}

function duration(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function monthlyPerformanceBuild(title: string, monthLabel: string, fromDate: string, toDate: string, rows: AttendanceReportRow[], sort: SortMode, companyName: string): ReportBuild {
  const dates = dateRange(fromDate, toDate);
  const width = 10 + dates.length;
  const aoa: string[][] = [
    [title, ...blank(Math.max(0, width - 4)), "Report Month:-", monthLabel],
    [companyName, ...blank(width - 1)]
  ];
  const merges = [merge(0, 0, 0, Math.min(3, width - 1)), merge(1, 0, 1, width - 1)];
  const byWorker = groupBy(rows, (row) => `${row.workerCode}|${row.workerName}|${row.designation}`);
  const byDesignation = groupBy(Array.from(byWorker.entries()), ([, workerRows]) => groupKey(workerRows[0], sort));

  Array.from(byDesignation.entries()).forEach(([designation, workers]) => {
    aoa.push([groupLabel(sort), designation, ...blank(width - 2)]);
    merges.push(merge(aoa.length - 1, 1, aoa.length - 1, width - 1));
    aoa.push(["Empcode", "Name", "Workforce", "Designation", "Shift", "Present", "Full Day", "Half Day", "Absent", "Total Work", ...dates.map((date) => String(dateParts(date).day).padStart(2, "0"))]);
    workers.forEach(([workerKey, workerRows]) => {
      const [code, name] = workerKey.split("|");
      const byDate = new Map(workerRows.map((row) => [row.punchDate, row]));
      const present = dates.filter((date) => byDate.get(date)?.status === "P").length;
      const fullDay = dates.filter((date) => byDate.get(date)?.attendanceStatus === "Full Day").length;
      const halfDay = dates.filter((date) => byDate.get(date)?.attendanceStatus === "Half Day").length;
      const work = workerRows.reduce((sum, row) => sum + minutes(row.workHours), 0);
      aoa.push([
        code,
        name,
        workerRows[0].workerType,
        workerRows[0].designation,
        workerRows[0].shiftName,
        String(present),
        String(fullDay),
        String(halfDay),
        String(Math.max(0, dates.length - present)),
        duration(work),
        ...dates.map((date) => {
          const row = byDate.get(date);
          if (!row) return "A";
          if (row.punchCount % 2 === 1 || row.remark?.toLowerCase().includes("single") || row.remark?.toLowerCase().includes("missing")) return "MIS";
          if (row.attendanceStatus === "Full Day") return "FD";
          if (row.attendanceStatus === "Half Day") return "HD";
          return row.status === "P" ? "P" : "A";
        })
      ]);
    });
  });

  if (!rows.length) {
    aoa.push([groupLabel(sort), "No data", ...blank(width - 2)]);
    merges.push(merge(aoa.length - 1, 1, aoa.length - 1, width - 1));
  }

  return { aoa, merges, widths: [14, 24, 18, 20, 14, 8, 8, 8, 8, 12, ...dates.map(() => 6)] };
}

function monthlyInOutBuild(title: string, monthLabel: string, fromDate: string, toDate: string, rows: AttendanceReportRow[], sort: SortMode, companyName: string): ReportBuild {
  const dates = dateRange(fromDate, toDate);
  const header = ["Date", "Shift", "Scheduled", ...inOutHeader().slice(8)];
  const width = header.length;
  const aoa: string[][] = [
    [title, ...blank(Math.max(0, width - 4)), "Report Month:-", monthLabel],
    [companyName, ...blank(width - 1)]
  ];
  const merges = [merge(0, 0, 0, Math.min(3, width - 1)), merge(1, 0, 1, width - 1)];
  const workers = groupBy(rows, (row) => `${row.workerCode}|${row.workerName}|${row.designation}`);

  Array.from(workers.entries()).forEach(([workerKey, workerRows]) => {
    const [code, name, designation] = workerKey.split("|");
    aoa.push([groupLabel(sort), groupKey(workerRows[0], sort), ...blank(width - 2)]);
    merges.push(merge(aoa.length - 1, 1, aoa.length - 1, width - 1));
    aoa.push(["Empcode", code, "Name", name, ...blank(width - 4)]);
    merges.push(merge(aoa.length - 1, 3, aoa.length - 1, width - 1));
    aoa.push(header);
    const byDate = new Map(workerRows.map((row) => [row.punchDate, row]));
    dates.forEach((date) => {
      const row = byDate.get(date);
      if (!row) {
        aoa.push([displayDate(date), "Unassigned", "--:--", "--:--", ...blank(width - 4)]);
        return;
      }
      aoa.push([displayDate(date), row.shiftName, scheduleLabel(row), label(row, "In1") || row.inTime, ...inOutRow(row).slice(9)]);
    });
    const totalWork = workerRows.reduce((sum, row) => sum + minutes(row.workHours), 0);
    aoa.push(["", "", `Total Work+OT Hrs:- ${duration(totalWork)}`, "Total OT Hrs:- 00:00", "Total Break Hrs:- 00:00", ...blank(Math.max(0, width - 5))]);
    merges.push(merge(aoa.length - 1, 2, aoa.length - 1, Math.min(4, width - 1)));
  });

  if (!rows.length) {
    aoa.push(["Empcode", "No data", "No punches available for this filter.", ...blank(width - 3)]);
    merges.push(merge(aoa.length - 1, 2, aoa.length - 1, width - 1));
  }

  return { aoa, merges, widths: [12, 14, 14, 9, ...Array(width - 4).fill(8)] };
}

function buildReport(mode: ReportMode, reportType: AttendanceReportType, label: string, fromDate: string, toDate: string, rows: AttendanceReportRow[], sort: SortMode, companyName: string) {
  const title = reportTitle(mode, reportType);
  if (mode === "monthly" && reportType === "in_out") return monthlyInOutBuild(title, displayMonth(label), fromDate, toDate, rows, sort, companyName);
  if (mode === "monthly") return monthlyPerformanceBuild(title, displayMonth(label), fromDate, toDate, rows, sort, companyName);
  const dateLabel = mode === "periodic" ? `${displayDate(fromDate)} to ${displayDate(toDate)}` : displayDate(fromDate);
  return dailyBuild(title, dateLabel, rows, reportType, sort, companyName);
}

function styleSheet(sheet: XLSX.WorkSheet, build: ReportBuild) {
  sheet["!merges"] = build.merges;
  sheet["!cols"] = build.widths.map((wch) => ({ wch }));
  sheet["!margins"] = { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 };
}

function escapePdfText(value: unknown) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .slice(0, 140);
}

function makePdf(build: ReportBuild) {
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 30;
  const tableWidth = pageWidth - margin * 2;
  const rowHeight = 15;
  const rowsPerPage = 32;
  const maxColumns = Math.max(...build.aoa.map((row) => row.length));
  const baseWidths = build.widths.length >= maxColumns ? build.widths.slice(0, maxColumns) : [...build.widths, ...Array(maxColumns - build.widths.length).fill(8)];
  const widthUnits = baseWidths.reduce((sum, value) => sum + value, 0) || maxColumns;
  const columnWidths = baseWidths.map((value) => (value / widthUnits) * tableWidth);
  const pages: string[][][] = [];
  for (let index = 0; index < build.aoa.length; index += rowsPerPage) pages.push(build.aoa.slice(index, index + rowsPerPage));

  const objects: string[] = [""];
  const pageObjectNumbers: number[] = [];
  const catalogObjectNumber = 1;
  const pagesObjectNumber = 2;
  const fontObjectNumber = 3;
  objects[catalogObjectNumber] = `<< /Type /Catalog /Pages ${pagesObjectNumber} 0 R >>`;
  objects[fontObjectNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((pageRows, pageIndex) => {
    const commands: string[] = ["0.84 w"];
    let y = pageHeight - margin;
    pageRows.forEach((row, rowIndex) => {
      let x = margin;
      const isTitle = pageIndex === 0 && rowIndex < 2;
      const isGroup = row[0] === "Desg. Name" || row[0] === "Location" || row[0] === "Total For Whole Company" || row[0] === "Empcode";
      commands.push(isTitle || isGroup ? "0.90 0.90 0.90 rg" : "1 1 1 rg");
      commands.push(`${margin} ${y - rowHeight} ${tableWidth} ${rowHeight} re f`);
      commands.push("0.78 0.78 0.78 RG");
      commands.push(`${margin} ${y - rowHeight} ${tableWidth} ${rowHeight} re S`);
      row.slice(0, maxColumns).forEach((cell, columnIndex) => {
        const cellWidth = columnWidths[columnIndex] ?? 20;
        commands.push(`${x} ${y - rowHeight} ${cellWidth} ${rowHeight} re S`);
        const fontSize = maxColumns > 22 ? 5.2 : maxColumns > 14 ? 6.4 : 7.4;
        const text = escapePdfText(cell);
        commands.push("0 0 0 rg");
        commands.push(`BT /F1 ${isTitle ? 9 : fontSize} Tf ${x + 2} ${y - 10} Td (${text}) Tj ET`);
        x += cellWidth;
      });
      y -= rowHeight;
    });
    commands.push(`BT /F1 7 Tf ${pageWidth - 120} 18 Td (Page :- ${pageIndex + 1} Of ${pages.length}) Tj ET`);
    const content = commands.join("\n");
    const contentObjectNumber = objects.length;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageObjectNumber = objects.length;
    pageObjectNumbers.push(pageObjectNumber);
    objects.push(`<< /Type /Page /Parent ${pagesObjectNumber} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
  });

  objects[pagesObjectNumber] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf);
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root ${catalogObjectNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).hostname;
    const isOps = forwardedHost.toLowerCase().split(":")[0] === "ops.dropxlogistics.com" || forwardedHost.toLowerCase().startsWith("ops-");
    const pageCode = isOps ? "ops_attendance_reports" : "attendance_reports";
    if (!hasPermission(authorization, pageCode, "access")) return Response.json({ error: "Permission required" }, { status: 403 });
    if (!supabaseAdmin) return Response.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const companyId = requireCompanyId(authorization);
    const companyName = authorization.companyName?.trim() || "Company";
    const params = new URL(request.url).searchParams;
    const mode = safeMode(params.get("mode"));
    const legacyDate = safeDate(params.get("date"));
    const month = safeMonth(params.get("month"));
    const fromDate = safeDate(params.get("from_date") ?? legacyDate);
    const toDate = safeDate(params.get("to_date") ?? legacyDate);
    const periodicRange = normalizedRange(fromDate, toDate);
    const sort = safeSort(params.get("sort"));
    const reportType = safeReportType(params.get("report"));
    const locationId = params.get("location_id");
    const search = params.get("search") ?? "";
    const designations = params.getAll("designation").map((value) => value.trim()).filter(Boolean);
    const workerTypes = params.getAll("worker_type").map((value) => value.trim()).filter(Boolean);
    const format = params.get("format") === "pdf" ? "pdf" : "xlsx";
    const range = mode === "monthly"
      ? monthBounds(month)
      : { ...periodicRange, label: `${periodicRange.fromDate}-to-${periodicRange.toDate}` };

    const authorizedLocations = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
    if (authorizedLocations.error) throw new Error(authorizedLocations.error);
    const allowedLocationIds = (isOps
      ? resolveOperatingContext(authorizedLocations.locations).selectedLocations
      : authorizedLocations.locations
    ).map((location) => location.id);
    if (locationId && !allowedLocationIds.includes(locationId)) {
      return Response.json({ error: "Location is outside your allocated scope." }, { status: 403 });
    }
    const scopedRows = await loadAttendanceReportRows({
      companyId,
      fromDate: range.fromDate,
      locationIds: locationId ? [locationId] : allowedLocationIds,
      reportType,
      toDate: range.toDate
    });
    const rows = filterAttendanceReportRows(scopedRows, { designations, search, workerTypes });
    const build = buildReport(mode, reportType, range.label, range.fromDate, range.toDate, rows, sort, companyName);
    const filenameBase = `${reportTitle(mode, reportType).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${range.label}`;

    if (format === "pdf") {
      const buffer = makePdf(build);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
          "Content-Type": "application/pdf"
        }
      });
    }

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(build.aoa);
    styleSheet(sheet, build);
    XLSX.utils.book_append_sheet(workbook, sheet, "Attendance");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Disposition": `attachment; filename="${filenameBase}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to export attendance report." }, { status: 500 });
  }
}
