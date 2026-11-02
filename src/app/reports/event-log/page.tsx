
import { ReportTable } from "@/components/report-table";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { EventLogDetails } from "@/components/event-log-details";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Params = { from?: string; to?: string; platform?: string; outcome?: string; event?: string; search?: string; page?: string; per_page?: string };
type EventRow = { id: string; platform: string; event_code: string; module: string; action: string; outcome: string; actor_label: string | null; actor_identifier: string | null; subject_code: string | null; subject_label: string | null; route: string | null; metadata: unknown; created_at: string };
const platforms = { dashboard: "Dashboard", dropx_one_android: "DropX One Android", dropx_one_web: "DropX One Web" } as Record<string, string>;

function integer(value: string | undefined, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function safe(value: string | undefined) { return String(value ?? "").replace(/[,%()]/g, " ").trim(); }
function href(params: Params, page: number) { const next = new URLSearchParams(); Object.entries(params).forEach(([key, value]) => { if (value && key !== "page") next.set(key, value); }); next.set("page", String(page)); return `/reports/event-log?${next}`; }

export const dynamic = "force-dynamic";

export default async function EventLogPage({ searchParams = {} }: { searchParams?: Params }) {
  const authorization = await requirePagePermission("event_log_reports", "access");
  const companyId = requireCompanyId(authorization);
  const page = integer(searchParams.page, 1);
  const pageSize = [20, 50, 100].includes(integer(searchParams.per_page, 20)) ? integer(searchParams.per_page, 20) : 20;
  const search = safe(searchParams.search);
  let rows: EventRow[] = [];
  let total = 0;
  let error: string | null = null;
  if (!supabaseAdmin) error = "Supabase service role key is not configured.";
  else {
    let query = supabaseAdmin.from("dashboard_app_event_logs")
      .select("id, platform, event_code, module, action, outcome, actor_label, actor_identifier, subject_code, subject_label, route, metadata, created_at", { count: "exact" })
      .eq("company_id", companyId).order("created_at", { ascending: false });
    if (searchParams.from) query = query.gte("created_at", `${searchParams.from}T00:00:00+05:30`);
    if (searchParams.to) query = query.lte("created_at", `${searchParams.to}T23:59:59.999+05:30`);
    if (searchParams.platform) query = query.eq("platform", searchParams.platform);
    if (searchParams.outcome) query = query.eq("outcome", searchParams.outcome);
    if (searchParams.event) query = query.eq("event_code", searchParams.event);
    if (search) query = query.or(`event_code.ilike.%${search}%,module.ilike.%${search}%,actor_label.ilike.%${search}%,actor_identifier.ilike.%${search}%,subject_code.ilike.%${search}%,subject_label.ilike.%${search}%,route.ilike.%${search}%`);
    const result = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (result.error) error = result.error.message;
    else { rows = (result.data ?? []) as EventRow[]; total = result.count ?? rows.length; }
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return <AppShell active="Event Log" pageCode="event_log_reports">
    <PageHead eyebrow="Reports" title="Event Log" subtitle="Review activity from Dashboard, DropX One Android, and DropX One Web. Sensitive form values and credentials are never recorded." />
    {error ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load event log</strong><p className="subtle">{error} Run scripts/dashboard_app_event_logs_v1.sql in Supabase SQL Editor if the table is not installed.</p></div></section> : null}
    <section className="panel"><form className="event-log-filters">
      <label>From<input className="field" defaultValue={searchParams.from} name="from" type="date" /></label>
      <label>To<input className="field" defaultValue={searchParams.to} name="to" type="date" /></label>
      <label>Platform<select className="field" defaultValue={searchParams.platform} name="platform"><option value="">All platforms</option>{Object.entries(platforms).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Result<select className="field" defaultValue={searchParams.outcome} name="outcome"><option value="">All results</option><option value="info">Information</option><option value="success">Success</option><option value="warning">Warning</option><option value="failed">Failed</option></select></label>
      <label>Event<select className="field" defaultValue={searchParams.event} name="event"><option value="">All events</option><option value="page_view">Dashboard page view</option><option value="ui_action">Dashboard action</option><option value="form_submit">Dashboard form submit</option><option value="screen_view">App screen view</option><option value="app_action">App action</option><option value="app_form_submit">App form submit</option><option value="app_lifecycle">App lifecycle</option></select></label>
      <label className="event-log-search">Search<input className="field" defaultValue={searchParams.search} name="search" placeholder="User, account, event, route" /></label>
      <label>Rows<select className="field" defaultValue={String(pageSize)} name="per_page"><option>20</option><option>50</option><option>100</option></select></label>
      <div className="event-log-filter-actions"><button className="button" type="submit">Apply</button><Link className="button secondary" href="/reports/event-log">Clear</Link></div>
    </form></section>
    <section className="panel"><div className="panel-head"><div><h2>Event history</h2><p className="subtle">{total ? `Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total} records.` : "No matching records."} Newest events are shown first.</p></div></div>
      <div className="table-wrap verification-api-report-table"><ReportTable><thead><tr><th>Date and time</th><th>Event</th><th>Module</th><th>Performed by</th><th>Platform</th><th>Subject</th><th>Result</th><th>Route</th><th>Data</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}><td>{formatDashboardDateTime(row.created_at)}</td><td><strong>{row.event_code.replaceAll("_", " ")}</strong><small>{row.action}</small></td><td>{row.module}</td><td><strong>{row.actor_label || "-"}</strong><small>{row.actor_identifier || ""}</small></td><td>{platforms[row.platform] ?? row.platform}</td><td><strong>{row.subject_label || "-"}</strong><small>{row.subject_code || ""}</small></td><td><StatusPill status={row.outcome} /></td><td>{row.route || "-"}</td><td><EventLogDetails metadata={row.metadata} /></td></tr>)}
        {!rows.length ? <tr><td className="empty-cell" colSpan={9}>No event records found.</td></tr> : null}
      </tbody></ReportTable></div>
      <div className="verification-api-pagination"><Link aria-disabled={page <= 1} className={page <= 1 ? "button secondary disabled" : "button secondary"} href={page <= 1 ? "#" : href(searchParams, page - 1)}>Previous</Link><span>Page {Math.min(page, totalPages)} of {totalPages}</span><Link aria-disabled={page >= totalPages} className={page >= totalPages ? "button secondary disabled" : "button secondary"} href={page >= totalPages ? "#" : href(searchParams, page + 1)}>Next</Link></div>
    </section>
  </AppShell>;
}
