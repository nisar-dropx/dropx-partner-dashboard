import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SearchableSelect } from "@/components/searchable-select";
import { StatusPill } from "@/components/status-pill";
import {
  type AttendanceReportType,
  istDate,
  loadAttendanceReportRows
} from "@/lib/biometric/attendance";
import { attendanceReportFilterOptions, filterAttendanceReportRows } from "@/lib/biometric/attendance-report-filters";
import { currentAccessSurface } from "@/lib/access-surface";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  hide_from_location_list?: boolean | null;
};

type ReportMode = "daily" | "monthly" | "periodic";
type SortMode = "workforce_type" | "designation" | "location";

const dailyReportOptions: Array<{ value: AttendanceReportType; label: string }> = [
  { value: "performance", label: "Daily Performance" },
  { value: "absent", label: "Daily Absent" },
  { value: "in_out", label: "Daily In/Out" },
  { value: "late_in", label: "Daily Late IN" },
  { value: "present", label: "Daily Present Report" },
  { value: "early_out", label: "Daily Early OUT Report" },
  { value: "mis_punch", label: "Daily Mis Punch Report" }
];

const monthlyReportOptions: Array<{ value: AttendanceReportType; label: string }> = [
  { value: "performance", label: "Month Performance" },
  { value: "in_out", label: "Month IN/OUT Report" },
  { value: "present", label: "Month Present Report" },
  { value: "absent", label: "Month Absent Report" },
  { value: "late_in", label: "Month Late In Report" },
  { value: "early_out", label: "Month Early OUT Report" },
  { value: "mis_punch", label: "Month Mis Punch Report" }
];

const periodicReportOptions: Array<{ value: AttendanceReportType; label: string }> = [
  { value: "performance", label: "Periodic Report" },
  { value: "in_out", label: "Periodic IN/OUT Report" },
  { value: "present", label: "Periodic Present Report" },
  { value: "absent", label: "Periodic Absent Report" },
  { value: "late_in", label: "Periodic Late IN Report" },
  { value: "early_out", label: "Periodic Early OUT Report" },
  { value: "mis_punch", label: "Periodic Mis Punch Report" }
];

const modeOptions = [
  { value: "daily", label: "Daily Report" },
  { value: "monthly", label: "Monthly Report" },
  { value: "periodic", label: "Periodic Report" }
];

const sortingOptions = [
  { value: "workforce_type", label: "By Workforce Type" },
  { value: "designation", label: "By Designation Wise" },
  { value: "location", label: "By Location Wise" }
];

const inOutColumns = ["Out1", "In2", "Out2", "In3", "Out3", "In4", "Out4", "In5", "Out5", "In6", "Out6", "In7", "Out7", "In8", "Out8"];

function safeMode(value: string | undefined): ReportMode {
  return value === "monthly" || value === "periodic" ? value : "daily";
}

function safeSort(value: string | undefined): SortMode {
  return value === "designation" || value === "location" ? value : "workforce_type";
}

function normalizedRange(fromDate: string, toDate: string) {
  return fromDate <= toDate ? { fromDate, toDate } : { fromDate: toDate, toDate: fromDate };
}

function optionsForMode(mode: ReportMode) {
  if (mode === "monthly") return monthlyReportOptions;
  if (mode === "periodic") return periodicReportOptions;
  return dailyReportOptions;
}

function safeReportType(value: string | undefined, mode: ReportMode): AttendanceReportType {
  const options = optionsForMode(mode);
  return options.some((option) => option.value === value) ? value as AttendanceReportType : "performance";
}

function todayIst() {
  return istDate(new Date());
}

function currentMonth() {
  return todayIst().slice(0, 7);
}

function safeDate(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayIst();
}

function safeMonth(value: string | undefined) {
  return value && /^\d{4}-\d{2}$/.test(value) ? value : currentMonth();
}

function monthBounds(month: string) {
  const [year, rawMonth] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, rawMonth - 1, 1));
  const end = new Date(Date.UTC(year, rawMonth, 0));
  return {
    fromDate: start.toISOString().slice(0, 10),
    toDate: end.toISOString().slice(0, 10)
  };
}

async function loadLocations(companyId: string, locationScopeIds: string[], hasAllLocationAccess: boolean) {
  if (!supabaseAdmin) return [] as LocationRow[];
  const { data, error } = await supabaseAdmin
    .from("stations")
    .select("id, station_code, station_name, hide_from_location_list")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("station_code");
  if (error) throw new Error(error.message);
  const locations = (data ?? []) as LocationRow[];
  return hasAllLocationAccess
    ? locations
    : locations.filter((location) => locationScopeIds.includes(location.id) && !location.hide_from_location_list);
}

export const dynamic = "force-dynamic";

export default async function AttendanceReportsPage({
  searchParams
}: {
  searchParams?: {
    date?: string;
    from_date?: string;
    location_id?: string;
    mode?: string;
    month?: string;
    report?: string;
    sort?: string;
    search?: string;
    designation?: string;
    worker_type?: string;
    to_date?: string;
  };
}) {
  const pageCode = currentAccessSurface() === "ops" ? "ops_attendance_reports" : "attendance_reports";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const mode = safeMode(searchParams?.mode);
  const date = safeDate(searchParams?.date);
  const month = safeMonth(searchParams?.month);
  const fromDate = safeDate(searchParams?.from_date);
  const toDate = safeDate(searchParams?.to_date);
  const reportType = safeReportType(searchParams?.report, mode);
  const reportOptions = optionsForMode(mode);
  const reportMeta = reportOptions.find((option) => option.value === reportType) ?? reportOptions[0];
  const sort = safeSort(searchParams?.sort);
  const locationId = String(searchParams?.location_id ?? "");
  const search = String(searchParams?.search ?? "").trim();
  const designation = String(searchParams?.designation ?? "");
  const workerType = String(searchParams?.worker_type ?? "");
  const activeRange = mode === "monthly"
    ? monthBounds(month)
    : mode === "periodic"
      ? normalizedRange(fromDate, toDate)
      : { fromDate: date, toDate: date };

  let rows: Awaited<ReturnType<typeof loadAttendanceReportRows>> = [];
  let locations: LocationRow[] = [];
  let filterOptions = { designations: [] as string[], workerTypes: [] as string[] };
  let error: string | null = null;

  try {
    locations = await loadLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
    const allowedLocationIds = new Set(locations.map((location) => location.id));
    const selectedLocationIds = locationId && allowedLocationIds.has(locationId)
      ? [locationId]
      : authorization.hasAllLocationAccess ? undefined : locations.map((location) => location.id);
    const scopedRows = await loadAttendanceReportRows({
      companyId,
      fromDate: activeRange.fromDate,
      locationIds: selectedLocationIds,
      reportType,
      toDate: activeRange.toDate
    });
    filterOptions = attendanceReportFilterOptions(scopedRows);
    rows = filterAttendanceReportRows(scopedRows, { designation, search, workerType });
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Unable to load attendance reports.";
  }

  const presentCount = rows.filter((row) => row.status === "P").length;
  const absentCount = rows.filter((row) => row.status === "A").length;
  const misPunchCount = rows.filter((row) => row.remark.toLowerCase().includes("single") || row.remark.toLowerCase().includes("missing")).length;
  const punchLabelOrder = ["In1", "Out1", "In2", "Out2", "In3", "Out3", "In4", "Out4", "In5", "Out5", "In6", "Out6", "In7", "Out7", "In8", "Out8"];
  const lastPunch = rows
    .flatMap((row) => punchLabelOrder.map((label) => ({ row, label, time: row.labels[label] })))
    .filter((entry) => entry.time && entry.time !== "--:--")
    .at(-1);
  const locationOptions = [
    { value: "", label: "All locations", helper: "Company-wide report" },
    ...locations.map((location) => ({
      value: location.id,
      label: location.station_code,
      helper: location.station_name ?? undefined
    }))
  ];

  return (
    <AppShell active="Attendance" pageCode={pageCode}>
      <PageHead
        eyebrow="Reports"
        title="Attendance"
        subtitle="Generate biometric attendance reports and export them for payroll checks."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run `scripts/biometric_attendance_upgrade_existing_tables.sql` in Supabase SQL Editor, then refresh this page.
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel attendance-report-builder">
        <form className="form-grid three" action="/attendance" method="get">
          <label>Report period
            <SearchableSelect name="mode" options={modeOptions} defaultValue={mode} placeholder="Daily, monthly, or date range" required />
          </label>
          {mode === "monthly" ? (
            <label>Month<input className="field" name="month" type="month" defaultValue={month} /></label>
          ) : mode === "periodic" ? (
            <>
              <label>From date<input className="field" name="from_date" type="date" defaultValue={fromDate} /></label>
              <label>To date<input className="field" name="to_date" type="date" defaultValue={toDate} /></label>
            </>
          ) : (
            <label>Report date<input className="field" name="date" type="date" defaultValue={date} /></label>
          )}
          <label>Sorting
            <SearchableSelect name="sort" options={sortingOptions} defaultValue={sort} placeholder="Select sorting" required />
          </label>
          <label>Location
            <SearchableSelect name="location_id" options={locationOptions} defaultValue={locationId} placeholder="All locations" />
          </label>
          <label>Designation
            <SearchableSelect name="designation" options={[{ value: "", label: "All designations" }, ...filterOptions.designations.map((value) => ({ value, label: value }))]} defaultValue={designation} placeholder="All designations" />
          </label>
          <label>Workforce type
            <SearchableSelect name="worker_type" options={[{ value: "", label: "All workforce types" }, ...filterOptions.workerTypes.map((value) => ({ value, label: value }))]} defaultValue={workerType} placeholder="All workforce types" />
          </label>
          <label className="span-3">Search
            <input className="field" name="search" defaultValue={search} placeholder="Name, DropX ID, biometric ID, location or designation" />
          </label>

          <fieldset className="span-3 report-choice-panel">
            <legend>{modeOptions.find((option) => option.value === mode)?.label}</legend>
            <div className="report-radio-grid">
              {reportOptions.map((option) => (
                <label key={`${mode}-${option.value}`} className="radio-card">
                  <input name="report" type="radio" value={option.value} defaultChecked={option.value === reportType} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="span-3 helper-card">
            <strong>{mode === "periodic" ? "Date range report" : mode === "monthly" ? "Monthly report" : "Daily report"}</strong>
            {mode === "periodic" ? " Select From date and To date, then export the same range to Excel or PDF." : mode === "monthly" ? " Select a month and export the month-level attendance summary." : " Select one punch date and export the daily attendance report."}
          </div>

          <div className="form-actions span-3 align-right">
            <button className="button secondary" type="submit">Show report</button>
            <button className="button secondary" formAction="/api/attendance/export" name="format" type="submit" value="xlsx">Download Excel</button>
            <button className="button" formAction="/api/attendance/export" name="format" type="submit" value="pdf">Download PDF</button>
          </div>
        </form>
      </section>

      <section className="summary-grid">
        <div className="metric-card">
          <span>Total rows</span>
          <strong>{rows.length}</strong>
          <small>{reportMeta.label}</small>
        </div>
        <div className="metric-card">
          <span>Present</span>
          <strong>{presentCount}</strong>
          <small>Calculated from active punches</small>
        </div>
        <div className="metric-card">
          <span>Absent</span>
          <strong>{absentCount}</strong>
          <small>Attendance daily status</small>
        </div>
        <div className="metric-card">
          <span>Mis punch</span>
          <strong>{misPunchCount}</strong>
          <small>Single or missing out punch</small>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>{reportMeta.label}</h2>
            <p className="subtle">
              {lastPunch ? `Last visible punch: ${lastPunch.row.workerName} ${lastPunch.label} at ${lastPunch.time}` : "No punches available for this filter."}
            </p>
          </div>
          <StatusPill status={`${rows.length} records`} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empcode</th>
                <th>Name</th>
                <th>Location</th>
                <th>Designation</th>
                <th>INTime</th>
                {reportType === "in_out" ? inOutColumns.map((column) => <th key={column}>{column}</th>) : null}
                <th>OUTTime</th>
                <th>Work+OT</th>
                <th>Punches</th>
                <th>Status</th>
                <th>Remark</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row) => (
                <tr key={`${row.enrolmentId}-${row.punchDate}-${row.workerCode}`}>
                  <td><strong>{row.workerCode}</strong></td>
                  <td>{row.workerName}</td>
                  <td>{row.location}</td>
                  <td>{row.designation}</td>
                  <td>{row.labels.In1 ?? row.inTime}</td>
                  {reportType === "in_out" ? inOutColumns.map((column) => <td key={column}>{row.labels[column] ?? "--:--"}</td>) : null}
                  <td>{row.outTime}</td>
                  <td>{row.workHours}</td>
                  <td>{row.punchCount}</td>
                  <td><StatusPill status={row.status === "P" ? "Present" : "Absent"} /></td>
                  <td>{row.remark || "-"}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={reportType === "in_out" ? 24 : 10}>No attendance rows found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
