
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { OnboardingScopeFilter } from "@/components/onboarding-scope-filter";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { updateOnboardingStatus } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string; stations?: string; clusters?: string; saved?: string; error?: string };
type ImportBatch = { id: string; source_type: string; file_name: string; report_from: string | null; report_to: string | null; created_at: string };
type ImportRow = { id: string; batch_id: string; source_type: string; station_code: string | null; work_date: string | null; raw_data: Record<string, unknown> | null; normalized_data: Record<string, unknown> | null; created_at: string };
function clean(value: unknown) { return String(value ?? "").trim(); }
function key(value: unknown) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function find(record: Record<string, unknown>, aliases: string[]) {
  const aliasKeys = aliases.map(key);
  const exact = Object.entries(record).find(([label]) => aliasKeys.includes(key(label)));
  if (exact) return clean(exact[1]);
  const partial = Object.entries(record).find(([label]) => aliasKeys.some((alias) => key(label).includes(alias)));
  return clean(partial?.[1]);
}
function merged(row: ImportRow) { return { ...(row.raw_data ?? {}), ...(row.normalized_data ?? {}) }; }
function normalizeStation(value: unknown) { return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function isOnboardingRow(row: ImportRow) {
  const record = merged(row);
  const labels = Object.keys(record).map(key);
  return labels.some((label) => label.includes("transporter")) && labels.some((label) => label.includes("email") || label.includes("mailid")) && labels.some((label) => label.includes("station"));
}
function daysSince(value: string) { return Math.max(0, Math.floor((Date.now() - new Date(`${value}T00:00:00+05:30`).getTime()) / 86400000)); }

export default async function ExecutiveIdOnboardingPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("executive_id_onboarding", "access");
  const companyId = requireCompanyId(authorization);
  const { locations } = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const permitted = resolveOperatingContext(locations).selectedLocations;
  const permittedCodes = permitted.map((location) => location.station_code);
  const requestedStations = clean(searchParams?.stations).split(",").map(normalizeStation).filter((code) => permittedCodes.includes(code));
  const requestedClusters = clean(searchParams?.clusters).split(",").map((value) => value.trim()).filter(Boolean);
  const selectedCodes = requestedStations.length ? [...new Set(requestedStations)] : permittedCodes;
  const status = ["all", "cleared"].includes(clean(searchParams?.status)) ? clean(searchParams?.status) : "pending";

  const batchResult = supabaseAdmin ? await supabaseAdmin.from("report_import_batches")
    .select("id,source_type,file_name,report_from,report_to,created_at").eq("company_id", companyId)
    .order("created_at", { ascending: false }).limit(30) : { data: [] as ImportBatch[], error: null };
  const batches = (batchResult.data ?? []) as ImportBatch[];
  const rowResult = supabaseAdmin && batches.length ? await supabaseAdmin.from("report_import_rows")
    .select("id,batch_id,source_type,station_code,work_date,raw_data,normalized_data,created_at")
    .eq("company_id", companyId).in("batch_id", batches.map((batch) => batch.id)).limit(10000) : { data: [] as ImportRow[], error: null };
  const candidateRows = ((rowResult.data ?? []) as ImportRow[]).filter(isOnboardingRow);
  const latestBatchId = batches.find((batch) => candidateRows.some((row) => row.batch_id === batch.id))?.id;
  const latestBatch = batches.find((batch) => batch.id === latestBatchId);
  const locationMap = new Map(permitted.map((location) => [location.station_code, location]));
  const sourceRows = candidateRows.filter((row) => row.batch_id === latestBatchId).map((row) => {
    const record = merged(row);
    const station = normalizeStation(row.station_code || find(record, ["station code", "station", "location code"]));
    const rawStatus = find(record, ["status", "onboarding status", "pending status"]);
    const opsStatus = clean(row.normalized_data?.ops_clearance_status) || (/(clear|complete|done|active)/i.test(rawStatus) ? "cleared" : "pending");
    const pendingSince = find(record, ["pending since", "pending from", "date", "report date"]) || row.work_date || latestBatch?.report_to || row.created_at.slice(0, 10);
    return {
      row,
      station,
      daName: find(record, ["da name", "associate name", "delivery associate name", "name"]),
      email: find(record, ["mail id", "email id", "email"]),
      transporterId: find(record, ["transporter id", "transporter", "provider id"]),
      pendingSince,
      sourceStatus: rawStatus || "Pending",
      actionItem: clean(row.normalized_data?.ops_action_item) || find(record, ["action item", "action required", "remarks", "reason"]) || "Review and complete in-app onboarding",
      opsStatus
    };
  }).filter((row) => selectedCodes.includes(row.station) && (status === "all" || row.opsStatus === status));
  const pending = sourceRows.filter((row) => row.opsStatus !== "cleared").length;
  const cleared = sourceRows.filter((row) => row.opsStatus === "cleared").length;
  const oldestPending = pending ? Math.max(...sourceRows.filter((row) => row.opsStatus !== "cleared").map((row) => daysSince(row.pendingSince))) : 0;

  return <AppShell active="Executive ID Onboarding" pageCode="executive_id_onboarding"><div className="onboarding-workspace">
    <PageHead eyebrow="Executive Setup" title="Executive ID Onboarding" subtitle="Amazon in-app onboarding, ID readiness and action closure." />
    <div className="onboarding-toolbar">
      <OnboardingScopeFilter stations={permitted.map((location) => ({ code: location.station_code, name: location.station_name || location.city || location.station_code, cluster: location.cluster || "Unassigned" }))} selectedStations={selectedCodes} selectedClusters={requestedClusters} status={status}/>
      <form className="onboarding-status-filter"><label>Status<select name="status" defaultValue={status}><option value="pending">Pending</option><option value="cleared">Cleared</option><option value="all">All</option></select></label>{selectedCodes.length !== permittedCodes.length ? <input type="hidden" name="stations" value={selectedCodes.join(",")}/> : null}<button>Apply</button></form>
    </div>
    {searchParams?.saved ? <div className="message-panel success">Action status updated.</div> : null}
    {searchParams?.error || batchResult.error || rowResult.error ? <div className="message-panel error">{searchParams?.error || batchResult.error?.message || rowResult.error?.message}</div> : null}
    <section className="performance-summary-grid">
      <article><span>Pending</span><strong>{pending}</strong><small>Action required</small></article>
      <article><span>Cleared</span><strong>{cleared}</strong><small>Closed items</small></article>
      <article><span>Oldest pending</span><strong>{oldestPending} days</strong><small>Ageing</small></article>
      <article><span>Latest upload</span><strong>{formatDashboardDate(latestBatch?.created_at, "—")}</strong><small>{latestBatch?.file_name || "No matching batch"}</small></article>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Onboarding action register</h2><p className="subtle">{latestBatch ? `${sourceRows.length} records from the latest daily upload` : "No onboarding upload was identified in the recent report batches."}</p></div></div>
      <div className="table-wrap"><ReportTable className="onboarding-table"><thead><tr><th>DA</th><th>Email</th><th>Transporter ID</th><th>Station / Cluster</th><th>Pending since</th><th>Upload status</th><th>Action item</th><th>Closure</th></tr></thead><tbody>
        {sourceRows.map(({ row, station, daName, email, transporterId, pendingSince, sourceStatus, actionItem, opsStatus }) => { const location = locationMap.get(station); return <tr key={row.id}><td><strong>{daName || "—"}</strong></td><td>{email || "—"}</td><td><strong>{transporterId || "—"}</strong></td><td><strong>{station}</strong><small>{location?.cluster || "Unassigned cluster"}</small></td><td>{pendingSince}<small>{daysSince(pendingSince)} days</small></td><td><span className="status-badge warning">{sourceStatus}</span></td><td>{actionItem}</td><td><form action={updateOnboardingStatus} className="inline-status-form onboarding-action-form"><input type="hidden" name="id" value={row.id}/><input type="hidden" name="station_code" value={station}/><select name="status" defaultValue={opsStatus}><option value="pending">Not cleared</option><option value="cleared">Cleared</option></select><input name="action_item" defaultValue={actionItem} aria-label={`Action item for ${daName}`}/><button>Save</button></form></td></tr>; })}
        {!sourceRows.length ? <tr><td colSpan={8} className="empty-cell">No onboarding records match this scope and status.</td></tr> : null}
      </tbody></ReportTable></div>
    </section>
  </div></AppShell>;
}
