import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { ReportImportUploader } from "@/components/report-import-uploader";
import { isReportAutoUiEnabled } from "@/lib/report-auto-worker";
import { ShipmentCoverageVisibility } from "@/components/shipment-coverage-visibility";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { ReportImportMaster, reportSchedule } from "@/lib/report-import-master";
import { loadCodLocations, locationModelName, providerName } from "@/lib/ops-pulse/cod";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";

type ImportBatch = {
  id: string;
  source_type: string;
  file_name: string;
  row_count: number;
  imported_row_count: number;
  skipped_row_count: number;
  station_code: string | null;
  status: string;
  message: string | null;
  report_from: string | null;
  report_to: string | null;
  created_at: string;
};

type ShipmentCoverageRow = {
  source_type: string;
  parent_station_code: string;
  business_date: string;
  shipment_count: number;
  last_uploaded_at: string;
};

function todayInIndia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function validDate(value?: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayInIndia();
}

function displayDate(value: string) {
  return formatDashboardDate(value);
}

function displayDateTime(value: string) {
  return formatDashboardDateTime(value);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousWeekday(value: string, weekday: number) {
  const date = new Date(`${value}T00:00:00Z`);
  const daysBack = (date.getUTCDay() - weekday + 7) % 7 || 7;
  return addDays(value, -daysBack);
}

function dueTimePassed(report: ReportImportMaster, date: string, today: string) {
  if (date < today) return true;
  if (date > today) return false;
  if (!report.upload_time) return false;
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
  return now >= report.upload_time.slice(0, 5);
}

// These 4 sources' actual data is always one calendar day older than the
// day they're being checked for — the same lag the auto-upload route
// shifts around (see addDaysYmd(requestedDate, -1) in auto-run/route.ts).
// report_import_master.day_offset for bpcl_fuel/iocl_fuel is configured as
// 0 ("D0"), which describes when the checklist expects the row to be due,
// not which calendar date the underlying data actually covers — using it
// directly here made the checklist look for a same-day batch that this
// source can never produce, so "select 25 Aug -> we correctly fetch and
// tag 24 Aug's data" never satisfied 25 Aug's own row. Override the
// effective offset for these 4 to match the real one-day lag instead of
// trusting day_offset, which describes something else (schedule timing).
const REAL_DATA_LAG_SOURCES = new Set(["bpcl_fuel", "iocl_fuel", "delivered_shipment_detail", "cashbook"]);

function effectiveDayOffset(report: ReportImportMaster) {
  return REAL_DATA_LAG_SOURCES.has(report.source_code) ? -1 : report.day_offset;
}

function reportIsDue(report: ReportImportMaster, date: string) {
  if (report.frequency === "weekly" && report.weekday !== null) {
    return new Date(`${date}T00:00:00Z`).getUTCDay() === report.weekday;
  }
  return report.frequency !== "adhoc";
}

function createdDateInIndia(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function batchMatchesDate(batch: ImportBatch, date: string) {
  if (batch.report_from && batch.report_to) return batch.report_from <= date && batch.report_to >= date;
  if (batch.report_from) return batch.report_from === date;
  return createdDateInIndia(batch.created_at) === date;
}

function successfulBatchCoversDate(batch: ImportBatch, sourceCode: string, date: string) {
  const status = batch.status.toLowerCase();
  return batch.source_type === sourceCode
    && (status === "completed" || status === "success" || status === "succeeded")
    && batchMatchesDate(batch, date);
}

async function loadImportMaster(companyId: string | null) {
  if (!companyId || !supabaseAdmin) return { rows: [] as ReportImportMaster[], error: null as string | null };
  const { data, error } = await supabaseAdmin
    .from("report_import_master")
    .select("id, source_code, name, description, file_types, day_offset, upload_time, frequency, weekday, parser_type, dedupe_fields, is_active, requires_station, station_scope, requires_report_date, report_date_label, date_default_offset")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("name");
  if (error) return { rows: [] as ReportImportMaster[], error: error.message };
  return {
    rows: ((data ?? []) as ReportImportMaster[]).filter((report) => Array.isArray(report.file_types) && report.file_types.length > 0),
    error: null
  };
}

async function loadBatches(companyId: string | null) {
  if (!companyId || !supabaseAdmin) return { rows: [] as ImportBatch[], error: null as string | null };
  const { data, error } = await supabaseAdmin
    .from("report_import_batches")
    .select("id, source_type, station_code, file_name, row_count, imported_row_count, skipped_row_count, status, message, report_from, report_to, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { rows: [] as ImportBatch[], error: error.message };
  return { rows: (data ?? []) as ImportBatch[], error: null };
}

export async function ReportUploadPageContent({
  active = "Report Imports",
  pageCode = "imports",
  selectedDate,
  selectedReport,
  showShipmentCoverage = false
}: {
  active?: string;
  pageCode?: string;
  selectedDate?: string;
  selectedReport?: string;
  showShipmentCoverage?: boolean;
}) {
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = authorization.companyId;
  const date = validDate(selectedDate);
  const [{ rows: reports, error: masterError }, { rows: batches, error: batchError }, locationResult] = await Promise.all([
    loadImportMaster(companyId),
    loadBatches(companyId),
    companyId
      ? loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)
      : Promise.resolve({ locations: [], error: null })
  ]);
  const stationIds = locationResult.locations.map((location) => location.id);
  const parentRows = companyId && supabaseAdmin && stationIds.length
    ? await supabaseAdmin.from("stations").select("id, parent_station_id").eq("company_id", companyId).in("id", stationIds)
    : { data: [] as Array<{ id: string; parent_station_id: string | null }> };
  const parentById = new Map((parentRows.data ?? []).map((row) => [row.id, row.parent_station_id]));
  const codeById = new Map(locationResult.locations.map((location) => [location.id, location.station_code]));
  const childCodesByParent = new Map<string, string[]>();
  parentById.forEach((parentId, childId) => {
    if (!parentId) return;
    const childCode = codeById.get(childId);
    if (childCode) childCodesByParent.set(parentId, [...(childCodesByParent.get(parentId) ?? []), childCode]);
  });
  const shipmentStations = locationResult.locations.map((location) => ({
    id: location.id,
    code: location.station_code,
    name: location.station_name || location.city || location.station_code,
    model: locationModelName(location),
    provider: providerName(location),
    parentStationId: parentById.get(location.id) ?? null,
    childCodes: (childCodesByParent.get(location.id) ?? []).sort()
  }));
  const expectedShipmentStations = shipmentStations
    .filter((station) =>
      !station.parentStationId
      && station.code.toUpperCase() !== "TEST"
      && station.provider.toUpperCase().includes("AMAZON")
      && ["DSP", "EDSP"].includes(station.model.toUpperCase()))
    .sort((a, b) => a.code.localeCompare(b.code));
  const coverageResult = companyId && supabaseAdmin
    ? await supabaseAdmin
      .from("shipment_import_coverage")
      .select("source_type, parent_station_code, business_date, shipment_count, last_uploaded_at")
      .eq("company_id", companyId)
      .eq("business_date", date)
    : { data: [] as ShipmentCoverageRow[], error: null };
  const coverageRows = (coverageResult.data ?? []) as ShipmentCoverageRow[];
  const coverageByKey = new Map(coverageRows.map((row) => [`${row.source_type}|${row.parent_station_code}`, row]));
  const stationBatch = (sourceType: string, stationCodes: string[]) => {
    const expectedCodes = new Set(stationCodes.map((code) => code.trim().toUpperCase()).filter(Boolean));
    return batches.find((batch) =>
      batch.source_type === sourceType
      && createdDateInIndia(batch.created_at) === date
      && (batch.station_code ?? "")
        .split(",")
        .map((code) => code.trim().toUpperCase())
        .some((code) => expectedCodes.has(code)));
  };
  const stationCoverage = expectedShipmentStations.map((station) => {
    const statusFor = (sourceType: string) => {
      const coverage = coverageByKey.get(`${sourceType}|${station.code}`);
      if (coverage) return { status: "Uploaded", count: coverage.shipment_count, uploadedAt: coverage.last_uploaded_at };
      const batch = stationBatch(sourceType, [station.code, ...station.childCodes]);
      if (batch && ["completed", "success", "succeeded"].includes(batch.status.toLowerCase())) {
        return {
          status: "Uploaded",
          count: batch.imported_row_count || batch.row_count,
          uploadedAt: batch.created_at
        };
      }
      if (batch && ["processing", "failed"].includes(batch.status.toLowerCase())) {
        return { status: batch.status, count: 0, uploadedAt: batch.created_at };
      }
      return { status: "Pending", count: 0, uploadedAt: null };
    };
    return {
      station,
      delivered: statusFor("delivered_shipment_detail"),
      inbound: statusFor("inbound_shipment_detail")
    };
  }).sort((a, b) => {
    const priority = (row: typeof a) => Number(row.delivered.status === "Uploaded") + Number(row.inbound.status === "Uploaded");
    return priority(a) - priority(b) || a.station.code.localeCompare(b.station.code);
  });
  const deliveredUploaded = stationCoverage.filter((row) => row.delivered.status === "Uploaded").length;
  const inboundUploaded = stationCoverage.filter((row) => row.inbound.status === "Uploaded").length;
  const dueReports = reports.filter((report) => reportIsDue(report, date));
  const reportBySource = new Map(reports.map((report) => [report.source_code, report]));
  const latestBySource = new Map<string, ImportBatch>();
  dueReports.forEach((report) => {
    const reportDate = addDays(date, effectiveDayOffset(report));
    const batch = batches.find((candidate) =>
      successfulBatchCoversDate(candidate, report.source_code, reportDate))
      ?? batches.find((candidate) =>
        candidate.source_type === report.source_code
        && (batchMatchesDate(candidate, reportDate) || createdDateInIndia(candidate.created_at) === date));
    if (batch) latestBySource.set(report.source_code, batch);
  });
  const today = todayInIndia();
  const latestShipmentHref = `/imports?shipment=1&date=${today}${selectedReport ? `&report=${encodeURIComponent(selectedReport)}` : ""}`;
  const coverageGaps = reports.flatMap((report) => {
    if (report.frequency === "adhoc" || report.frequency === "monthly") return [];
    const expectedPeriods: { dueDate: string; reportDate: string }[] = [];
    if (report.frequency === "daily") {
      for (let daysBack = 14; daysBack >= 0; daysBack -= 1) {
        const dueDate = addDays(today, -daysBack);
        if (dueTimePassed(report, dueDate, today)) {
          expectedPeriods.push({ dueDate, reportDate: addDays(dueDate, effectiveDayOffset(report)) });
        }
      }
    } else if (report.weekday !== null) {
      let dueDate = previousWeekday(addDays(today, 1), report.weekday);
      for (let week = 0; week < 6; week += 1) {
        if (dueTimePassed(report, dueDate, today)) {
          expectedPeriods.push({ dueDate, reportDate: addDays(dueDate, effectiveDayOffset(report)) });
        }
        dueDate = addDays(dueDate, -7);
      }
    }
    const missing = expectedPeriods.filter(({ reportDate }) =>
      !batches.some((batch) => successfulBatchCoversDate(batch, report.source_code, reportDate)));
    return missing.length ? [{ report, missing }] : [];
  });
  const recentBatches = batches.slice(0, 10);
  return (
    <AppShell active={active} pageCode={pageCode}>
      <PageHead
        eyebrow="Report Imports"
        title="Report imports"
        subtitle="Upload files and check missing coverage."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Connected" : "Database unavailable"}</span>}
      />

      {masterError || batchError || locationResult.error || coverageResult.error ? (
        <section className="panel message-panel error"><div className="panel-body"><strong>{masterError ?? batchError ?? locationResult.error ?? coverageResult.error?.message}</strong></div></section>
      ) : null}

      <section className="panel">
        <div className="panel-head compact-import-head">
          <div><h2>Upload report</h2></div>
          <div className="toolbar-actions">
            <Link className="button secondary compact" href="/master/imports">Manage reports</Link>
          </div>
        </div>
        <ReportImportUploader reports={reports} stations={shipmentStations} compact autoEnabled={isReportAutoUiEnabled()} />
      </section>

      <ShipmentCoverageVisibility defaultVisible={showShipmentCoverage}>
        <section className="panel shipment-checklist-panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Station upload checklist</h2>
              <p className="subtle">{displayDate(date)} · Delivered {deliveredUploaded}/{stationCoverage.length} · Inbound {inboundUploaded}/{stationCoverage.length}</p>
            </div>
            <form className="toolbar-actions" method="get">
              <input name="shipment" type="hidden" value="1" />
              {selectedReport ? <input name="report" type="hidden" value={selectedReport} /> : null}
              <input key={date} aria-label="Shipment coverage date" className="field compact-date" defaultValue={date} name="date" type="date" />
              <button className="button secondary compact" type="submit">View</button>
              <Link className="button secondary compact" href={latestShipmentHref}>Latest</Link>
            </form>
          </div>
          <div className="table-wrap shipment-checklist-table">
            <table>
              <thead><tr><th>Station</th><th>Delivered data</th><th>Inbound data</th></tr></thead>
              <tbody>
                {stationCoverage.map((row) => (
                  <tr key={`shipment-coverage-${row.station.id}`}>
                    <td>
                      <strong>{row.station.code} · {row.station.name}</strong>
                      {row.station.childCodes.length ? <div className="subtle">Includes XPT: {row.station.childCodes.join(", ")}</div> : null}
                    </td>
                    <td>
                      <StatusPill status={row.delivered.status} />
                      {row.delivered.count ? <span className="subtle"> {row.delivered.count.toLocaleString("en-IN")} shipments</span> : null}
                    </td>
                    <td>
                      <StatusPill status={row.inbound.status} />
                      {row.inbound.count ? <span className="subtle"> {row.inbound.count.toLocaleString("en-IN")} shipments</span> : null}
                    </td>
                  </tr>
                ))}
                {!stationCoverage.length ? <tr><td className="empty-cell" colSpan={3}>No eligible Amazon DSP or EDSP parent stations are available.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </ShipmentCoverageVisibility>

      {coverageGaps.length ? (
        <details className="panel import-gap-panel">
          <summary className="panel-head">
            <div><h2>Coverage gaps</h2><p className="subtle">Missing daily and weekly reports.</p></div>
            <StatusPill status={`${coverageGaps.length} reports need attention`} />
          </summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Report</th><th>Frequency</th><th>Missing periods</th><th>Action</th></tr></thead>
              <tbody>
                {coverageGaps.map(({ report, missing }) => (
                  <tr key={`coverage-${report.id}`}>
                    <td><strong>{report.name}</strong></td>
                    <td>{report.frequency}</td>
                    <td>{missing.slice(-8).map(({ reportDate }) => displayDate(reportDate)).join(", ")}{missing.length > 8 ? ` · +${missing.length - 8} earlier` : ""}</td>
                    <td><Link className="button secondary compact" href={`/imports?date=${missing[missing.length - 1].dueDate}`}>Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <section className="panel message-panel success">
          <div className="panel-body"><strong>Report coverage is complete for the monitored daily and weekly periods.</strong></div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>{displayDate(date)}</h2>
            <p className="subtle">Expected reports and latest upload result.</p>
          </div>
          <form className="toolbar-actions" method="get">
            <input aria-label="Status date" className="field compact-date" defaultValue={date} name="date" type="date" />
            <button className="button secondary compact" type="submit">View</button>
            <Link className="button secondary compact" href="/imports">Today</Link>
          </form>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Report</th><th>Upload time</th><th>Frequency</th><th>Report day</th><th>Status</th><th>File</th><th>Rows</th></tr>
            </thead>
            <tbody>
              {dueReports.map((report) => {
                const batch = latestBySource.get(report.source_code);
                const schedule = reportSchedule(report).split(" · ");
                const status = batch?.status ?? "Pending";
                return (
                  <tr key={report.id}>
                    <td><strong>{report.name}</strong></td>
                    <td>{schedule[1]}</td>
                    <td>{report.frequency === "weekly" && report.weekday !== null ? schedule[2] : report.frequency}</td>
                    <td>{schedule[0]}</td>
                    <td><StatusPill status={status} /></td>
                    <td>{batch?.file_name ?? "-"}</td>
                    <td>{batch ? `${batch.imported_row_count} imported · ${batch.skipped_row_count} skipped` : "-"}</td>
                  </tr>
                );
              })}
              {!dueReports.length ? <tr><td className="empty-cell" colSpan={7}>No reports due on this date.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Upload log</h2>
            <p className="subtle">Latest upload activity.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Uploaded</th><th>Report</th><th>Report period</th><th>Result</th><th>Rows</th><th>File</th></tr></thead>
            <tbody>
              {recentBatches.map((batch) => {
                const report = reportBySource.get(batch.source_type);
                const period = batch.report_from
                  ? batch.report_to && batch.report_to !== batch.report_from
                    ? `${displayDate(batch.report_from)} – ${displayDate(batch.report_to)}`
                    : displayDate(batch.report_from)
                  : "-";
                return (
                  <tr key={batch.id}>
                    <td>{displayDateTime(batch.created_at)}</td>
                    <td><strong>{report?.name ?? batch.source_type}</strong></td>
                    <td>{period}</td>
                    <td><StatusPill status={batch.status} /></td>
                    <td>{batch.status.toLowerCase() === "failed" ? "-" : `${batch.imported_row_count} imported · ${batch.skipped_row_count} skipped`}</td>
                    <td>{batch.file_name}</td>
                  </tr>
                );
              })}
              {!recentBatches.length ? <tr><td className="empty-cell" colSpan={6}>No upload activity yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
