import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PerformanceWorkspaceTabs } from "@/components/performance-workspace-tabs";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import {
  buildReviewStatusRows,
  reviewStatusDateRange,
  reviewStatusDates,
  type ReviewStatusKind,
  type ReviewStatusRow
} from "@/lib/ops-pulse/review-status";
import { loadReviewStatusDataset } from "@/lib/ops-pulse/review-status-data";
import "./review-status.css";

export const dynamic = "force-dynamic";

type SearchParams = {
  from?: string;
  to?: string;
  status?: string;
  region?: string;
  cluster?: string;
  aom?: string;
  station?: string;
  q?: string;
  page?: string;
};

const PAGE_SIZE = 100;

function kolkataDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function statusLabel(status: ReviewStatusKind) {
  return status === "completed" ? "Completed" : status === "in_progress" ? "In progress" : "Not started";
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function hrefFor(base: SearchParams, overrides: Partial<SearchParams>) {
  const params = new URLSearchParams();
  const values = { ...base, ...overrides };
  Object.entries(values).forEach(([key, value]) => {
    if (value && value !== "all") params.set(key, value);
  });
  return `/performance/review-status${params.size ? `?${params.toString()}` : ""}`;
}

function filterRows(rows: ReviewStatusRow[], filters: SearchParams) {
  const query = String(filters.q ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status && filters.status !== "all" && row.status !== filters.status) return false;
    if (filters.region && filters.region !== "all" && row.region !== filters.region) return false;
    if (filters.cluster && filters.cluster !== "all" && row.clusterManager !== filters.cluster) return false;
    if (filters.aom && filters.aom !== "all" && row.aom !== filters.aom) return false;
    if (filters.station && filters.station !== "all" && row.stationId !== filters.station) return false;
    if (query && !`${row.stationCode} ${row.stationName} ${row.region} ${row.clusterManager} ${row.aom} ${row.currentDependency}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function StepStatus({ row }: { row: ReviewStatusRow }) {
  if (!row.steps.length) {
    const route = [row.clusterManager, row.aom, row.nationalHead].filter(Boolean).join(" → ");
    return <p className="review-status-empty-detail">No review has been opened. {route ? `Current People route: ${route}.` : "Complete the reporting hierarchy in People before starting."}</p>;
  }
  return <div className="review-status-steps">
    {row.steps.map((step) => <article className={step.status} key={step.id}>
      <span>{step.step_order}</span>
      <div>
        <strong>{step.reviewer_role}</strong>
        <b>{step.reviewer_name}</b>
        <small>
          {step.status === "completed"
            ? `Reviewed${step.proxy_reviewer_name ? ` by ${step.proxy_reviewer_name} as proxy` : ""}${step.completed_at ? ` · ${formatDashboardDateTime(step.completed_at)}` : ""}`
            : step.status === "skipped"
              ? `Skipped${step.bypassed_by_name ? ` by ${step.bypassed_by_name}` : ""}${step.bypassed_at ? ` · ${formatDashboardDateTime(step.bypassed_at)}` : ""}`
              : step.proxy_reviewer_name ? `Proxy assigned to ${step.proxy_reviewer_name}` : "Pending"}
        </small>
        {step.feedback ? <p>{step.feedback}</p> : null}
        {step.proxy_reason ? <p><em>Proxy reason:</em> {step.proxy_reason}</p> : null}
        {step.bypass_reason ? <p><em>Skip reason:</em> {step.bypass_reason}</p> : null}
      </div>
    </article>)}
  </div>;
}

function ReviewStatusDetail({ row }: { row: ReviewStatusRow }) {
  const openItems = row.items.filter((item) => item.status !== "done");
  const openFollowups = row.followups.filter((item) => item.status !== "done");
  const discussion = row.updates.filter((update) => update.update_type !== "action").slice(0, 4);
  return <div className="review-status-detail">
    <div className="review-status-detail-head">
      <div><span>Started</span><strong>{formatDashboardDateTime(row.review?.started_at, "Not started")}</strong></div>
      <div><span>Last activity</span><strong>{formatDashboardDateTime(row.lastActivityAt, "—")}</strong></div>
      <div><span>RCA recorded</span><strong>{row.items.filter((item) => item.root_cause || item.corrective_action).length}</strong></div>
      <div><span>Open actions</span><strong>{openItems.length + openFollowups.length}</strong></div>
      <div><span>Discussion updates</span><strong>{row.updates.length}</strong></div>
      <Link className="button secondary compact" href={`/performance?view=reviews&date=${row.date}&review=${encodeURIComponent(row.stationCode)}`}>Open review</Link>
    </div>
    <StepStatus row={row} />
    <div className="review-status-notes">
      <section>
        <span>Review takeaway</span>
        <p>{row.review?.review_summary || "No takeaway has been saved."}</p>
      </section>
      <section>
        <span>Open RCA / actions</span>
        {openItems.length || openFollowups.length ? <ul>
          {openItems.slice(0, 4).map((item) => <li key={`${item.metric_label}-${item.due_date}`}><b>{item.metric_label}</b>{item.corrective_action || item.root_cause || "Action details pending"}{item.action_owner ? ` · ${item.action_owner}` : ""}{item.due_date ? ` · ETA ${formatDashboardDate(item.due_date)}` : ""}</li>)}
          {openFollowups.slice(0, 4).map((item) => <li key={`followup-${item.action_number}`}><b>Action {item.action_number}</b>{item.title} · {item.owner_label} · ETA {formatDashboardDate(item.due_date)}</li>)}
        </ul> : <p>No open action has been recorded.</p>}
      </section>
      <section>
        <span>Latest discussion</span>
        {discussion.length ? <ul>{discussion.map((update, index) => <li key={`${update.created_at}-${index}`}><b>{update.author_name || update.author_role || "Reviewer"}</b>{update.note}</li>)}</ul> : <p>No discussion has been saved.</p>}
      </section>
    </div>
  </div>;
}

export default async function PerformanceReviewStatusPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await requirePagePermission("performance_review_status", "access");
  const companyId = requireCompanyId(authorization);
  const todayDate = kolkataDate();
  const latestDate = dateShift(todayDate, -1);
  const range = reviewStatusDateRange({ from: searchParams?.from, to: searchParams?.to ?? latestDate, latestDate: todayDate });
  const locationsResult = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const locations = resolveOperatingContext(locationsResult.locations).modeLocations;
  const dataset = await loadReviewStatusDataset(companyId, locations.map((location) => location.station_code), range.from, range.to);
  const allRows = buildReviewStatusRows({ dates: reviewStatusDates(range.from, range.to), locations, ...dataset });
  const filters: SearchParams = {
    from: range.from,
    to: range.to,
    status: searchParams?.status ?? "all",
    region: searchParams?.region ?? "all",
    cluster: searchParams?.cluster ?? "all",
    aom: searchParams?.aom ?? "all",
    station: searchParams?.station ?? "all",
    q: searchParams?.q ?? ""
  };
  const rows = filterRows(allRows, filters).sort((left, right) => {
    const dateOrder = right.date.localeCompare(left.date);
    if (dateOrder) return dateOrder;
    const statusOrder = { not_started: 0, in_progress: 1, completed: 2 };
    return statusOrder[left.status] - statusOrder[right.status] || left.stationCode.localeCompare(right.stationCode);
  });
  const requestedPage = Number(searchParams?.page ?? 1);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(requestedPage, totalPages)) : 1;
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const completed = rows.filter((row) => row.status === "completed").length;
  const inProgress = rows.filter((row) => row.status === "in_progress").length;
  const notStarted = rows.filter((row) => row.status === "not_started").length;
  const completionRate = rows.length ? Math.round(completed / rows.length * 100) : 0;
  const regions = unique(allRows.map((row) => row.region));
  const clusters = unique(allRows.map((row) => row.clusterManager));
  const aoms = unique(allRows.map((row) => row.aom));
  const todayFilters = { ...filters, page: undefined };
  const mtdFrom = latestDate.slice(0, 8) + "01";
  const canViewReviews = hasPermission(authorization, "performance_review", "access");
  const canManageAccess = hasPermission(authorization, "users", "access");

  return <AppShell active="Review Status" pageCode="performance_review_status">
    <main className="ops-command-center performance-workspace review-status-workspace">
      <PageHead
        eyebrow="Performance"
        title="Review Status"
        subtitle="One view of every station review, reviewer stage and pending dependency."
        action={canManageAccess ? <Link className="button secondary compact" href="/users?section=roles">Manage access</Link> : undefined}
      />
      <PerformanceWorkspaceTabs active="status" canViewReviews={canViewReviews} canViewReviewStatus />

      <nav className="review-status-presets" aria-label="Review date presets">
        <Link className={range.from === latestDate && range.to === latestDate ? "active" : ""} href={hrefFor(todayFilters, { from: latestDate, to: latestDate, page: undefined })}>Previous day</Link>
        <Link className={range.from === dateShift(latestDate, -6) && range.to === latestDate ? "active" : ""} href={hrefFor(todayFilters, { from: dateShift(latestDate, -6), to: latestDate, page: undefined })}>7 days</Link>
        <Link className={range.from === dateShift(latestDate, -13) && range.to === latestDate ? "active" : ""} href={hrefFor(todayFilters, { from: dateShift(latestDate, -13), to: latestDate, page: undefined })}>14 days</Link>
        <Link className={range.from === mtdFrom && range.to === latestDate ? "active" : ""} href={hrefFor(todayFilters, { from: mtdFrom, to: latestDate, page: undefined })}>MTD</Link>
      </nav>

      <form className="review-status-filters" method="get">
        <label><span>From</span><input name="from" type="date" defaultValue={range.from} max={todayDate} /></label>
        <label><span>To</span><input name="to" type="date" defaultValue={range.to} max={todayDate} /></label>
        <label><span>Status</span><select name="status" defaultValue={filters.status}><option value="all">All statuses</option><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="completed">Completed</option></select></label>
        <label><span>Region</span><select name="region" defaultValue={filters.region}><option value="all">All regions</option>{regions.map((region) => <option key={region}>{region}</option>)}</select></label>
        <label><span>Cluster manager</span><select name="cluster" defaultValue={filters.cluster}><option value="all">All clusters</option>{clusters.map((cluster) => <option key={cluster}>{cluster}</option>)}</select></label>
        <label><span>AOM</span><select name="aom" defaultValue={filters.aom}><option value="all">All AOMs</option>{aoms.map((aom) => <option key={aom}>{aom}</option>)}</select></label>
        <label><span>Station</span><select name="station" defaultValue={filters.station}><option value="all">All stations</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.station_code} · {location.station_name || location.city || "Station"}</option>)}</select></label>
        <label className="review-status-search"><span>Find</span><input name="q" defaultValue={filters.q} placeholder="Station or reviewer" /></label>
        <button className="button compact">Apply</button>
        <Link className="button secondary compact" href="/performance/review-status">Clear</Link>
      </form>
      <p className="review-status-range-note">Defaults to the previous performance day; today remains available in the custom range · maximum 31 days per view.</p>

      {locationsResult.error || dataset.error ? <section className="panel message-panel error"><div className="panel-body">{locationsResult.error || dataset.error}</div></section> : null}

      <section className="review-status-summary" aria-label="Review completion summary">
        <article><span>Expected</span><strong>{rows.length}</strong><small>Station-day reviews</small></article>
        <article className="green"><span>Completed</span><strong>{completed}</strong><small>{completionRate}% completion</small></article>
        <article className="amber"><span>In progress</span><strong>{inProgress}</strong><small>Waiting at a review stage</small></article>
        <article className="red"><span>Not started</span><strong>{notStarted}</strong><small>No review opened</small></article>
      </section>

      <section className="review-status-register">
        <header>
          <div><h2>Station review register</h2><p>{rows.length} results · click any row for reviewers, RCA, actions and discussion.</p></div>
          <span>{formatDashboardDate(range.from)}{range.from !== range.to ? ` – ${formatDashboardDate(range.to)}` : ""}</span>
        </header>
        <div className="review-status-columns" aria-hidden="true"><span>Date</span><span>Station</span><span>Cluster manager</span><span>AOM</span><span>Status</span><span>Progress</span><span>Current dependency</span><span></span></div>
        <div className="review-status-rows">
          {pageRows.length ? pageRows.map((row) => <details className={`review-status-row ${row.status}`} key={row.key}>
            <summary>
              <span data-label="Date"><strong>{formatDashboardDate(row.date)}</strong><small>Performance day</small></span>
              <span data-label="Station"><strong>{row.stationCode}</strong><small>{row.stationName}</small></span>
              <span data-label="Cluster"><strong>{row.clusterManager || "Not configured"}</strong><small>{row.region || "Region not set"}</small></span>
              <span data-label="AOM"><strong>{row.aom || "No AOM layer"}</strong><small>{row.aom ? "Area Operations Manager" : "Route skips AOM"}</small></span>
              <span data-label="Status"><b className={`review-status-pill ${row.status}`}>{statusLabel(row.status)}</b></span>
              <span data-label="Progress"><strong>{row.totalSteps ? `${row.completedSteps + row.skippedSteps}/${row.totalSteps}` : "—"}</strong><small>{row.skippedSteps ? `${row.skippedSteps} skipped` : `${row.completedSteps} reviewed`}</small></span>
              <span data-label="Dependency"><strong>{row.currentDependency}</strong><small>{row.lastActivityAt ? formatDashboardDateTime(row.lastActivityAt) : "No activity"}</small></span>
              <i aria-hidden="true">⌄</i>
            </summary>
            <ReviewStatusDetail row={row} />
          </details>) : <div className="review-status-empty">No station reviews match these filters.</div>}
        </div>
        {totalPages > 1 ? <footer className="review-status-pagination">
          <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}</span>
          <div>{page > 1 ? <Link className="button secondary compact" href={hrefFor(filters, { page: String(page - 1) })}>Previous</Link> : null}<b>Page {page} of {totalPages}</b>{page < totalPages ? <Link className="button secondary compact" href={hrefFor(filters, { page: String(page + 1) })}>Next</Link> : null}</div>
        </footer> : null}
      </section>
    </main>
  </AppShell>;
}
