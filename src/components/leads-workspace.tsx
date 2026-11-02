
import { ReportTable } from "@/components/report-table";
import { PageHead } from "@/components/page-head";
import { syncMetaLeadAds } from "@/app/leads/actions";
import { SubmitButton } from "@/components/submit-button";
import { LeadAdsPanel } from "@/components/lead-ads-panel";
import { LeadReportsPanel } from "@/components/lead-reports-panel";
import { LeadSopPanel } from "@/components/lead-sop-panel";
import { formatDashboardDateTime } from "@/lib/date-format";
import type { LeadRow, LeadWorkspaceData } from "@/lib/leads-data";

type LeadsWorkspaceProps = {
  data: LeadWorkspaceData;
  section: "dashboard" | "all" | "followups" | "interviews" | "reports" | "ads" | "sop";
  canEditAds?: boolean;
  canSyncAds?: boolean;
  canAddSop?: boolean;
  canEditSop?: boolean;
  flash?: {
    error: string | null;
    notice: string | null;
  };
};

const tabs = [
  { key: "dashboard", label: "Dashboard", href: "/leads" },
  { key: "all", label: "All Leads", href: "/leads/all" },
  { key: "followups", label: "Follow-ups", href: "/leads/follow-ups" },
  { key: "interviews", label: "Interviews", href: "/leads/interviews" },
  { key: "reports", label: "Reports", href: "/leads/reports" },
  { key: "ads", label: "All Ads", href: "/leads/ads" },
  { key: "sop", label: "Ad SOP", href: "/leads/ad-sop" }
] as const;

function formatDate(value: string | null) {
  return formatDashboardDateTime(value);
}

function statusLabel(value: string | null) {
  return String(value ?? "-").replace(/_/g, " ");
}

function LeadTabs({ active }: { active: LeadsWorkspaceProps["section"] }) {
  return (
    <div className="lead-tabs" role="tablist">
      {tabs.map((tab) => (
        <a className={tab.key === active ? "active" : ""} href={tab.href} key={tab.key}>
          {tab.label}
        </a>
      ))}
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function LeadTable({ rows, mode }: { rows: LeadRow[]; mode: "all" | "followups" | "interviews" }) {
  return (
    <div className="table-wrap">
      <ReportTable className="lead-table">
        <thead>
          <tr>
            <th>Name / City</th>
            <th>Phone</th>
            <th>Station</th>
            <th>Role</th>
            <th>Source</th>
            <th>Status</th>
            {mode === "followups" ? <th>Follow-up</th> : null}
            {mode === "interviews" ? <th>Interview</th> : null}
            {mode === "interviews" ? <th>Final</th> : null}
            <th>Remarks</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((lead) => (
            <tr key={lead.id}>
              <td>
                <strong>{lead.full_name || "-"}</strong>
                <div className="subtle">{[lead.city, lead.postal_code].filter(Boolean).join(" ") || "-"}</div>
              </td>
              <td>{lead.phone || "-"}</td>
              <td><span className="mini-tag">{lead.station_code || "-"}</span></td>
              <td>{lead.job_code || "-"}</td>
              <td>{lead.source || "-"}</td>
              <td><span className="status-pill warn">{statusLabel(lead.status)}</span></td>
              {mode === "followups" ? <td>{formatDate(lead.follow_up_at)}</td> : null}
              {mode === "interviews" ? <td>{formatDate(lead.interview_at)}</td> : null}
              {mode === "interviews" ? <td>{statusLabel(lead.final_status)}</td> : null}
              <td>{lead.remarks || lead.final_remarks || "-"}</td>
              <td>{formatDate(lead.updated_at)}</td>
            </tr>
          )) : (
            <tr>
              <td colSpan={mode === "all" ? 8 : mode === "followups" ? 9 : 11}>
                <EmptyState>No lead data found.</EmptyState>
              </td>
            </tr>
          )}
        </tbody>
      </ReportTable>
    </div>
  );
}

function Dashboard({ data }: { data: LeadWorkspaceData }) {
  const metrics = [
    ["Total Leads", data.counts.total, "All captured lead rows"],
    ["No Status", data.counts.noStatus, "Needs first action"],
    ["No Response", data.counts.noResponse, "Retry queue"],
    ["Call Back", data.counts.callBack, "Scheduled follow-up"],
    ["Interviews", data.counts.interviews, "Interview scheduled"],
    ["Joined", data.counts.joined, "Converted leads"],
    ["24h+ Pending", data.counts.overdue, "No-status leads older than 24h"]
  ];

  return (
    <>
      <div className="lead-metrics">
        {metrics.map(([label, value, helper]) => (
          <div className="metric-card" key={label}>
            <span>{label}</span>
            <strong>{Number(value).toLocaleString("en-IN")}</strong>
            <small>{helper}</small>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Today&apos;s work queue</h2>
            <p className="subtle">Items that block lead conversion and station hiring visibility.</p>
          </div>
        </div>
        <div className="lead-process-grid">
          <a className="lead-process-card" href="/leads/all">
            <span>1</span>
            <strong>No-status leads</strong>
            <p>{data.counts.noStatus.toLocaleString("en-IN")} need first action</p>
          </a>
          <a className="lead-process-card" href="/leads/follow-ups">
            <span>2</span>
            <strong>No Response / Call Back</strong>
            <p>{(data.counts.noResponse + data.counts.callBack).toLocaleString("en-IN")} in retry pool</p>
          </a>
          <a className="lead-process-card" href="/leads/interviews">
            <span>3</span>
            <strong>Interview pipeline</strong>
            <p>{data.counts.interviews.toLocaleString("en-IN")} interviews scheduled</p>
          </a>
          <a className="lead-process-card" href="/leads/ads">
            <span>4</span>
            <strong>Ad visibility</strong>
            <p>{data.ads.length.toLocaleString("en-IN")} ads loaded</p>
          </a>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Station pressure</h2>
            <p className="subtle">Sorted by no-status and no-response pressure.</p>
          </div>
        </div>
        <div className="table-wrap">
          <ReportTable>
            <thead>
              <tr>
                <th>Station</th>
                <th>Total</th>
                <th>No Status</th>
                <th>No Response</th>
                <th>Call Back</th>
                <th>Interview</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.stationSummary.length ? data.stationSummary.map((row) => (
                <tr key={row.stationCode}>
                  <td><strong>{row.stationCode}</strong></td>
                  <td>{row.total}</td>
                  <td>{row.noStatus}</td>
                  <td>{row.noResponse}</td>
                  <td>{row.callBack}</td>
                  <td>{row.interview}</td>
                  <td>{row.joined}</td>
                </tr>
              )) : (
                <tr><td colSpan={7}><EmptyState>No station summary yet.</EmptyState></td></tr>
              )}
            </tbody>
          </ReportTable>
        </div>
      </section>
    </>
  );
}

function FilterBar({ type }: { type: "leads" | "reports" | "ads" }) {
  return (
    <div className="lead-filter-bar">
      <input className="field" placeholder={type === "ads" ? "Search ad, station, role" : "Search name, phone, city"} />
      <select className="field"><option>All Stations</option></select>
      <select className="field"><option>All Roles</option></select>
      {type !== "ads" ? <select className="field"><option>All Status</option></select> : <select className="field"><option>All Ad Status</option></select>}
    </div>
  );
}

export function LeadsWorkspace({ canAddSop = false, canEditAds = false, canEditSop = false, canSyncAds = false, data, flash, section }: LeadsWorkspaceProps) {
  const titles = {
    dashboard: ["Leads", "Lead command center", "Track hiring leads, follow-ups, interviews, reports, and Meta ad performance."],
    all: ["All Leads", "Complete lead register", "Search and work all captured lead rows."],
    followups: ["Follow-ups", "No Response / Call Back", "Retry no-response leads and handle due callback promises."],
    interviews: ["Interviews", "Interview scheduled", "Track interview dates, final status, remarks, and work email."],
    reports: ["Reports", "Lead reports", "Download filtered lead data for follow-up, interviews, and team review."],
    ads: ["All Ads", "Leads Management", "Track active, paused, and stopped ads with spend, budget, leads, and actions."],
    sop: ["Ad SOP", "Ad Posting SOP", "Name Meta ads and lead forms consistently so leads route correctly."]
  } satisfies Record<LeadsWorkspaceProps["section"], [string, string, string]>;
  const [activeTitle, title, subtitle] = titles[section];

  return (
    <div className="leads-workspace">
      <PageHead eyebrow={section === "ads" ? undefined : "Lead CRM"} title={title} subtitle={subtitle} action={<a className="button secondary" href="/settings/ads-leads">Ads & Leads Settings</a>} />
      <LeadTabs active={section} />

      {data.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Leads database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error} Run scripts/leads_v1.sql in Supabase SQL Editor.</p>
          </div>
        </section>
      ) : null}

      {flash?.error || flash?.notice ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!data.error && section === "dashboard" ? <Dashboard data={data} /> : null}
      {!data.error && section === "all" ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>{activeTitle}</h2>
              <p className="subtle">{data.recentLeads.length} rows loaded</p>
            </div>
            <FilterBar type="leads" />
          </div>
          <LeadTable rows={data.recentLeads} mode="all" />
        </section>
      ) : null}
      {!data.error && section === "followups" ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>{activeTitle}</h2>
              <p className="subtle">No Response and Call Back rows</p>
            </div>
            <FilterBar type="leads" />
          </div>
          <LeadTable rows={data.followups} mode="followups" />
        </section>
      ) : null}
      {!data.error && section === "interviews" ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>{activeTitle}</h2>
              <p className="subtle">Interview and final outcome rows</p>
            </div>
            <FilterBar type="leads" />
          </div>
          <LeadTable rows={data.interviews} mode="interviews" />
        </section>
      ) : null}
      {!data.error && section === "reports" ? (
        <section className="panel">
          <div className="panel-head"><h2>{activeTitle}</h2></div>
          <LeadReportsPanel ads={data.ads} leads={data.recentLeads} />
        </section>
      ) : null}
      {!data.error && section === "ads" ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>{activeTitle}</h2>
            </div>
            <div className="lead-ads-actions">
              {canSyncAds ? (
                <form action={syncMetaLeadAds}>
                  <SubmitButton className="button compact" pendingText="Syncing">
                    Sync Ads
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </div>
          <LeadAdsPanel ads={data.ads} canEdit={canEditAds} />
        </section>
      ) : null}
      {!data.error && section === "sop" ? <LeadSopPanel canAdd={canAddSop} canEdit={canEditSop} roles={data.roles} /> : null}
    </div>
  );
}
