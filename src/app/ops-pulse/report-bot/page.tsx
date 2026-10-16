import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { ReportBotConnection } from "@/components/report-bot-connection";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { formatClock, localClock, type AnalysisCheck } from "@/lib/report-bot/logic";
import { aiKeyConfigured, aiKeyName, aiProviderLabel, loadReportBotSettings, reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import {
  approveFeedback,
  connectWhatsApp,
  disconnectWhatsApp,
  reanalyseSubmission,
  rejectFeedback,
  rotateWorkerToken,
  saveBotSettings,
  saveReportType,
  saveSchedule,
  saveWorkerUrl,
  setRequestStatus,
  syncGroups,
  updateGroup
} from "./actions";

export const dynamic = "force-dynamic";

const TABS = [
  ["today", "Today"],
  ["review", "Review"],
  ["groups", "Groups"],
  ["reports", "Reports & schedules"],
  ["connection", "Connection"],
  ["settings", "Settings"]
] as const;
type Tab = (typeof TABS)[number][0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type GroupRow = {
  id: string; wa_group_id: string; group_name: string | null; participant_count: number | null; location_id: string | null;
  is_enabled: boolean; bot_in_group: boolean; last_synced_at: string | null;
};
type ReportTypeRow = { id: string; name: string; description: string | null; rules: string[]; is_active: boolean };
type ScheduleRow = {
  id: string; group_id: string; report_type_id: string; days_of_week: number[]; reminder_times: string[]; due_time: string;
  first_reminder_template: string; followup_template: string; overdue_template: string | null; is_active: boolean;
};
type SubmissionRow = {
  id: string; group_id: string; sender_name: string | null; sender_jid: string | null; caption: string | null; message_at: string;
  status: string; status_reason: string | null; verdict: string | null; confidence: number | null; feedback_text: string | null;
  storage_path: string | null; ai_result: { checks?: AnalysisCheck[]; extracted_summary?: string } | null; report_type_id: string | null;
};

function readFlash() {
  const raw = cookies().get("dropx_report_bot_flash")?.value;
  if (!raw) return {} as { error?: string; notice?: string; token?: string };
  try {
    return JSON.parse(raw) as { error?: string; notice?: string; token?: string };
  } catch {
    return {};
  }
}

function when(value: string | null | undefined, timeZone: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function sender(row: { sender_name: string | null; sender_jid: string | null }) {
  return row.sender_name || (row.sender_jid ? `+${row.sender_jid.split("@")[0].split(":")[0]}` : "-");
}

const STATUS_LABELS: Record<string, string> = {
  queued: "Analysing",
  blocked: "Blocked (settings)",
  awaiting_approval: "Waiting for review",
  queued_to_send: "Sending",
  sent: "Feedback sent",
  ignored: "Not a report",
  skipped: "Skipped",
  rejected: "Not sent (rejected)",
  failed: "Failed",
  pending: "Pending",
  overdue: "Overdue",
  received: "Received",
  missed: "Missed",
  cancelled: "Cancelled"
};

function Status({ value }: { value: string }) {
  return <StatusPill status={STATUS_LABELS[value] ?? value} />;
}

function ModeBanner({ settings }: { settings: ReportBotSettings }) {
  const aiReady = aiKeyConfigured(settings.ai_provider);
  const seen = settings.last_worker_seen_at ? Date.now() - new Date(settings.last_worker_seen_at).getTime() : Infinity;
  const workerFresh = seen < 3 * 60 * 1000;
  return (
    <section className="summary-grid">
      <div className="metric-card"><span>Mode</span><strong>{settings.mode === "live" ? "Live" : settings.mode === "listen" ? "Listen only" : "Off"}</strong><small>{settings.mode === "live" ? "Reminders and feedback are sent" : settings.mode === "listen" ? "Analyses images, sends nothing" : "Not listening"}</small></div>
      <div className="metric-card"><span>WhatsApp</span><strong>{settings.connection_state === "open" ? "Connected" : settings.connection_state === "unknown" ? "Not set up" : (STATUS_LABELS[settings.connection_state] ?? settings.connection_state)}</strong><small>{settings.connected_number ? `+${settings.connected_number}` : "No number linked"}</small></div>
      <div className="metric-card"><span>Worker</span><strong>{workerFresh ? "Online" : settings.last_worker_seen_at ? "Not responding" : "Not connected"}</strong><small>{settings.last_worker_seen_at ? `Last seen ${when(settings.last_worker_seen_at, settings.timezone)}` : "Set up under Connection"}</small></div>
      <div className="metric-card"><span>AI</span><strong>{aiReady ? "Ready" : "Key missing"}</strong><small>{aiReady ? `${aiProviderLabel(settings.ai_provider)} · ${settings.ai_model}` : `Add ${aiKeyName(settings.ai_provider)} in Vercel`}</small></div>
    </section>
  );
}

export default async function ReportBotPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, REPORT_BOT_PAGE, "edit");
  const tab: Tab = TABS.some(([key]) => key === searchParams?.tab) ? searchParams!.tab as Tab : "today";
  const flash = readFlash();
  const db = reportBotDb();
  let settings: ReportBotSettings;
  try {
    settings = await loadReportBotSettings(companyId);
  } catch (error) {
    return (
      <AppShell active="Report Bot" pageCode={REPORT_BOT_PAGE}>
        <PageHead eyebrow="Ops Pulse · Dark Store" title="Report Bot" />
        <section className="panel message-panel error"><div className="panel-body"><strong>Report Bot is not set up yet</strong><p className="subtle">{error instanceof Error ? error.message : "Unavailable"}. The database migration may not be applied.</p></div></section>
      </AppShell>
    );
  }
  const clock = localClock(new Date(), settings.timezone);
  const groupsResult = await db.from("report_bot_groups").select("*").eq("company_id", companyId).order("group_name");
  const groups = ((groupsResult.data ?? []) as GroupRow[]).filter((group) => canSeeGroup(authorization, group));
  const groupIds = groups.map((group) => group.id);
  const groupName = new Map(groups.map((group) => [group.id, group.group_name ?? group.wa_group_id]));
  const reportTypesResult = await db.from("report_bot_report_types").select("*").eq("company_id", companyId).order("name");
  const reportTypes = (reportTypesResult.data ?? []) as ReportTypeRow[];
  const reportName = new Map(reportTypes.map((report) => [report.id, report.name]));

  return (
    <AppShell active="Report Bot" pageCode={REPORT_BOT_PAGE}>
      <PageHead
        eyebrow="Ops Pulse · Dark Store"
        title="Report Bot"
        subtitle="WhatsApp group reminders for daily reports, and AI checks of the report photos teams post."
      />
      <ModeBanner settings={settings} />
      {flash.error || flash.notice ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`} role={flash.error ? "alert" : "status"}>
          <div className="panel-body">
            <strong>{flash.error ? "Action needed" : "Done"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
            {flash.token ? (
              <p style={{ marginTop: 8 }}>Worker token (shown once, copy it now): <code style={{ userSelect: "all", wordBreak: "break-all" }}>{flash.token}</code></p>
            ) : null}
          </div>
        </section>
      ) : null}
      <nav className="panel" aria-label="Report Bot sections">
        <div className="panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {TABS.map(([key, label]) => (
            <Link key={key} href={`/report-bot?tab=${key}`} className={`button ${tab === key ? "primary" : "secondary"}`} aria-current={tab === key ? "page" : undefined}>{label}</Link>
          ))}
        </div>
      </nav>

      {tab === "today" ? await TodayTab({ companyId, groupIds, groupName, reportName, settings, date: clock.date, canEdit }) : null}
      {tab === "review" ? await ReviewTab({ companyId, groupIds, groupName, reportName, settings, canEdit }) : null}
      {tab === "groups" ? await GroupsTab({ authorization, groups, canEdit }) : null}
      {tab === "reports" ? await ReportsTab({ companyId, groups, groupIds, reportTypes, canEdit }) : null}
      {tab === "connection" ? <ConnectionTab settings={settings} canEdit={canEdit} /> : null}
      {tab === "settings" ? <SettingsTab settings={settings} canEdit={canEdit} /> : null}
    </AppShell>
  );
}

async function TodayTab({ companyId, groupIds, groupName, reportName, settings, date, canEdit }: {
  companyId: string; groupIds: string[]; groupName: Map<string, string>; reportName: Map<string, string>; settings: ReportBotSettings; date: string; canEdit: boolean;
}) {
  const db = reportBotDb();
  const [requests, submissions] = groupIds.length ? await Promise.all([
    db.from("report_bot_requests").select("*, schedule:report_bot_schedules(due_time,reminder_times)").eq("company_id", companyId).eq("business_date", date).in("group_id", groupIds).order("created_at"),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).gte("message_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order("message_at", { ascending: false }).limit(100)
  ]) : [{ data: [] }, { data: [] }];
  const requestRows = (requests.data ?? []) as Array<{
    id: string; group_id: string; report_type_id: string; status: string; reminders_sent: number; received_at: string | null; last_verdict: string | null;
    schedule: { due_time: string; reminder_times: string[] } | null;
  }>;
  const submissionRows = (submissions.data ?? []) as SubmissionRow[];
  const received = requestRows.filter((row) => row.status === "received").length;
  return (
    <>
      <section className="summary-grid">
        <div className="metric-card"><span>Reports due today</span><strong>{requestRows.length}</strong><small>{date}</small></div>
        <div className="metric-card"><span>Received</span><strong>{received}</strong><small>{requestRows.length - received} still open</small></div>
        <div className="metric-card"><span>Images (24h)</span><strong>{submissionRows.length}</strong><small>{submissionRows.filter((row) => row.status === "awaiting_approval").length} waiting for review</small></div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Today&apos;s reports</h2><p className="subtle">One row per group and report scheduled today. Reminders stop as soon as a report image arrives.</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Group</th><th>Report</th><th>Due</th><th>Reminders sent</th><th>Status</th><th>Received</th><th>Last check</th>{canEdit ? <th>Action</th> : null}</tr></thead>
            <tbody>
              {requestRows.length ? requestRows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{groupName.get(row.group_id) ?? "-"}</strong></td>
                  <td>{reportName.get(row.report_type_id) ?? "-"}</td>
                  <td>{row.schedule ? formatClock(row.schedule.due_time) : "-"}</td>
                  <td>{row.reminders_sent} / {row.schedule?.reminder_times?.length ?? 0}</td>
                  <td><Status value={row.status} /></td>
                  <td>{when(row.received_at, settings.timezone)}</td>
                  <td>{row.last_verdict ? <Status value={row.last_verdict === "pass" ? "completed" : row.last_verdict === "fail" ? "failed" : "review"} /> : "-"}</td>
                  {canEdit ? (
                    <td>
                      {["pending", "overdue"].includes(row.status) ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="received" /><button className="button secondary" type="submit">Mark received</button></form>
                          <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="cancelled" /><button className="button secondary" type="submit">Cancel today</button></form>
                        </div>
                      ) : row.status === "cancelled" ? (
                        <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="pending" /><button className="button secondary" type="submit">Reopen</button></form>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              )) : <tr><td className="empty-cell" colSpan={canEdit ? 8 : 7}>{settings.mode === "off" ? "The bot is off. Turn on Listen only or Live under Settings." : "No reports are scheduled today for your groups."}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <SubmissionTable rows={submissionRows} groupName={groupName} reportName={reportName} timeZone={settings.timezone} title="Images in the last 24 hours" />
    </>
  );
}

function SubmissionTable({ rows, groupName, reportName, timeZone, title }: { rows: SubmissionRow[]; groupName: Map<string, string>; reportName: Map<string, string>; timeZone: string; title: string }) {
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>{title}</h2></div><span className="count-badge">{rows.length}</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Group</th><th>Sender</th><th>Report</th><th>Status</th><th>Result</th><th>Image</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.id}>
                <td>{when(row.message_at, timeZone)}</td>
                <td>{groupName.get(row.group_id) ?? "-"}</td>
                <td>{sender(row)}</td>
                <td>{row.report_type_id ? reportName.get(row.report_type_id) ?? "-" : "-"}</td>
                <td><Status value={row.status} />{row.status_reason ? <div className="subtle" style={{ maxWidth: 280 }}>{row.status_reason}</div> : null}</td>
                <td>{row.verdict ? `${row.verdict.replace("_", " ")}${row.confidence !== null ? ` · ${Math.round(Number(row.confidence) * 100)}%` : ""}` : "-"}</td>
                <td>{row.storage_path ? <a href={`/api/report-bot/image/${row.id}`} target="_blank" rel="noreferrer">Open</a> : "-"}</td>
              </tr>
            )) : <tr><td className="empty-cell" colSpan={7}>No images yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

async function ReviewTab({ companyId, groupIds, groupName, reportName, settings, canEdit }: {
  companyId: string; groupIds: string[]; groupName: Map<string, string>; reportName: Map<string, string>; settings: ReportBotSettings; canEdit: boolean;
}) {
  const db = reportBotDb();
  const [waiting, attention, recent] = groupIds.length ? await Promise.all([
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).eq("status", "awaiting_approval").order("message_at").limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["failed", "blocked"]).order("message_at", { ascending: false }).limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["sent", "ignored", "rejected", "skipped", "queued_to_send"]).order("message_at", { ascending: false }).limit(30)
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const waitingRows = (waiting.data ?? []) as SubmissionRow[];
  const attentionRows = (attention.data ?? []) as SubmissionRow[];
  return (
    <>
      <section className="panel">
        <div className="panel-head"><div><h2>Waiting for review</h2><p className="subtle">Check the AI reading against the image, edit the reply if needed, then approve. Nothing is posted until you approve{settings.approval_mode === "auto" ? " (high-confidence results are posted automatically in Live mode)" : ""}.</p></div><span className="count-badge">{waitingRows.length}</span></div>
        <div className="panel-body" style={{ display: "grid", gap: 16 }}>
          {waitingRows.length ? waitingRows.map((row) => (
            <article key={row.id} className="panel" style={{ margin: 0 }}>
              <div className="panel-body" style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <strong>{groupName.get(row.group_id) ?? "-"}</strong>
                  <span className="subtle">{sender(row)} · {when(row.message_at, settings.timezone)}</span>
                  <StatusPill status={row.verdict === "pass" ? "Looks good" : row.verdict === "fail" ? "Failed checks" : "Needs review"} />
                  {row.confidence !== null ? <span className="subtle">{Math.round(Number(row.confidence) * 100)}% confident</span> : null}
                  {row.report_type_id ? <span className="subtle">{reportName.get(row.report_type_id)}</span> : null}
                  {row.storage_path ? <a href={`/api/report-bot/image/${row.id}`} target="_blank" rel="noreferrer">Open image</a> : null}
                </div>
                {row.caption ? <p className="subtle">Caption: {row.caption}</p> : null}
                {row.ai_result?.extracted_summary ? <p>{row.ai_result.extracted_summary}</p> : null}
                {row.ai_result?.checks?.length ? (
                  <ul className="subtle-list">
                    {row.ai_result.checks.map((item, index) => <li key={index}><strong>{item.status.toUpperCase()}</strong> · {item.rule}{item.note ? ` - ${item.note}` : ""}</li>)}
                  </ul>
                ) : null}
                {canEdit ? (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <form action={approveFeedback} style={{ flex: "1 1 420px", display: "grid", gap: 8 }}>
                      <input type="hidden" name="id" value={row.id} />
                      <label>Reply to post in the group<textarea className="field" name="feedback_text" rows={5} defaultValue={row.feedback_text ?? ""} required maxLength={3000} /></label>
                      <div><SubmitButton className="button primary">Approve and send</SubmitButton></div>
                    </form>
                    <form action={rejectFeedback}><input type="hidden" name="id" value={row.id} /><button className="button secondary" type="submit">Don&apos;t send</button></form>
                    <form action={reanalyseSubmission}><input type="hidden" name="id" value={row.id} /><button className="button secondary" type="submit">Analyse again</button></form>
                  </div>
                ) : <p className="subtle">Proposed reply: {row.feedback_text}</p>}
              </div>
            </article>
          )) : <p className="subtle">Nothing waiting for review.</p>}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Needs attention</h2><p className="subtle">Images that could not be analysed or replies that could not be sent. Fix the cause shown, then retry.</p></div><span className="count-badge">{attentionRows.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Group</th><th>Sender</th><th>Problem</th><th>Image</th>{canEdit ? <th>Action</th> : null}</tr></thead>
            <tbody>
              {attentionRows.length ? attentionRows.map((row) => (
                <tr key={row.id}>
                  <td>{when(row.message_at, settings.timezone)}</td>
                  <td>{groupName.get(row.group_id) ?? "-"}</td>
                  <td>{sender(row)}</td>
                  <td><Status value={row.status} /><div className="subtle" style={{ maxWidth: 360 }}>{row.status_reason}</div></td>
                  <td>{row.storage_path ? <a href={`/api/report-bot/image/${row.id}`} target="_blank" rel="noreferrer">Open</a> : "-"}</td>
                  {canEdit ? (
                    <td style={{ display: "flex", gap: 6 }}>
                      <form action={reanalyseSubmission}><input type="hidden" name="id" value={row.id} /><button className="button secondary" type="submit">Retry</button></form>
                      <form action={rejectFeedback}><input type="hidden" name="id" value={row.id} /><button className="button secondary" type="submit">Dismiss</button></form>
                    </td>
                  ) : null}
                </tr>
              )) : <tr><td className="empty-cell" colSpan={canEdit ? 6 : 5}>Nothing needs attention.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <SubmissionTable rows={(recent.data ?? []) as SubmissionRow[]} groupName={groupName} reportName={reportName} timeZone={settings.timezone} title="Recently handled" />
    </>
  );
}

async function GroupsTab({ authorization, groups, canEdit }: { authorization: Awaited<ReturnType<typeof requirePagePermission>>; groups: GroupRow[]; canEdit: boolean }) {
  let stores: Array<{ id: string; station_code: string; station_name: string | null }> = [];
  let storeError: string | null = null;
  try {
    stores = (await darkStoreScope(authorization)).locations;
  } catch (error) {
    storeError = error instanceof Error ? error.message : "Stores could not be loaded.";
  }
  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div><h2>WhatsApp groups</h2><p className="subtle">Groups the linked number is a member of. Enable only the report groups; the bot ignores every other chat, and never reads private chats.</p></div>
        {canEdit ? <form action={syncGroups}><SubmitButton className="button primary">Refresh from WhatsApp</SubmitButton></form> : null}
      </div>
      {storeError ? <div className="panel-body"><p className="subtle" role="alert">{storeError}</p></div> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Group</th><th>Members</th><th>Bot in group</th><th>Store</th><th>Enabled</th>{canEdit ? <th /> : null}</tr></thead>
          <tbody>
            {groups.length ? groups.map((group) => {
              const formId = `group-${group.id}`;
              return (
                <tr key={group.id}>
                  <td><strong>{group.group_name ?? "Unnamed group"}</strong><div className="subtle">{group.wa_group_id}</div></td>
                  <td>{group.participant_count ?? "-"}</td>
                  <td>{group.bot_in_group ? <StatusPill status="Yes" tone="good" /> : <StatusPill status="Not a member" tone="bad" />}</td>
                  <td>
                    <select className="field" name="location_id" form={formId} defaultValue={group.location_id ?? ""} disabled={!canEdit}>
                      <option value="">{authorization.hasAllLocationAccess ? "No store" : "Choose store"}</option>
                      {stores.map((store) => <option key={store.id} value={store.id}>{store.station_code}{store.station_name ? ` · ${store.station_name}` : ""}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" name="is_enabled" form={formId} defaultChecked={group.is_enabled} disabled={!canEdit} aria-label={`Enable ${group.group_name ?? "group"}`} /></td>
                  {canEdit ? <td><form id={formId} action={updateGroup}><input type="hidden" name="group_id" value={group.id} /><button className="button secondary" type="submit">Save</button></form></td> : null}
                </tr>
              );
            }) : <tr><td className="empty-cell" colSpan={canEdit ? 6 : 5}>No groups yet. Link WhatsApp under Connection, then Refresh from WhatsApp.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportTypeForm({ report }: { report?: ReportTypeRow }) {
  return (
    <form action={saveReportType} className="form-grid three">
      {report ? <input type="hidden" name="id" value={report.id} /> : null}
      <label>Report name<input className="field" name="name" defaultValue={report?.name ?? ""} required maxLength={120} placeholder="EOD closure screenshot" /></label>
      <label className="span-2">What the image looks like (helps the AI recognise it)<input className="field" name="description" defaultValue={report?.description ?? ""} maxLength={1000} placeholder="Screenshot of the station EOD dashboard showing closure status" /></label>
      <label className="span-3">Rules to check, one per line<textarea className="field" name="rules" rows={5} defaultValue={report?.rules.join("\n") ?? ""} required placeholder={"Date on the screenshot is today's date\nPending liability shows zero\nStation code is visible"} /></label>
      <label><span><input type="checkbox" name="is_active" defaultChecked={report?.is_active ?? true} /> Active</span></label>
      <div className="form-actions span-2 align-right"><SubmitButton className="button primary">{report ? "Save report type" : "Add report type"}</SubmitButton></div>
    </form>
  );
}

function ScheduleForm({ schedule, groups, reportTypes }: { schedule?: ScheduleRow; groups: GroupRow[]; reportTypes: ReportTypeRow[] }) {
  return (
    <form action={saveSchedule} className="form-grid three">
      {schedule ? <input type="hidden" name="id" value={schedule.id} /> : null}
      <label>Group
        <select className="field" name="group_id" defaultValue={schedule?.group_id ?? ""} required>
          <option value="">Choose group</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.group_name ?? group.wa_group_id}{group.is_enabled ? "" : " (disabled)"}</option>)}
        </select>
      </label>
      <label>Report
        <select className="field" name="report_type_id" defaultValue={schedule?.report_type_id ?? ""} required>
          <option value="">Choose report</option>
          {reportTypes.map((report) => <option key={report.id} value={report.id}>{report.name}{report.is_active ? "" : " (inactive)"}</option>)}
        </select>
      </label>
      <label>Due time (24h)<input className="field" name="due_time" type="time" defaultValue={schedule?.due_time ?? "10:00"} required /></label>
      <fieldset className="span-3" style={{ border: 0, padding: 0, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <legend className="subtle">Days</legend>
        {DAY_NAMES.map((day, index) => (
          <label key={day}><input type="checkbox" name="days" value={index} defaultChecked={schedule ? schedule.days_of_week.includes(index) : true} /> {day}</label>
        ))}
      </fieldset>
      <label className="span-3">Reminder times (24h, comma separated; leave empty to track without reminding)<input className="field" name="reminder_times" defaultValue={schedule?.reminder_times.join(", ") ?? "09:00, 09:45"} placeholder="09:00, 09:45" /></label>
      <label className="span-3">First reminder<textarea className="field" name="first_reminder_template" rows={2} required defaultValue={schedule?.first_reminder_template ?? "Good morning {group} team. Please share today's *{report}* by {due_time}."} /></label>
      <label className="span-3">Follow-up reminder<textarea className="field" name="followup_template" rows={2} required defaultValue={schedule?.followup_template ?? "Reminder: *{report}* for {date} is still pending. Please share it here."} /></label>
      <label className="span-3">Overdue message at due time (optional)<textarea className="field" name="overdue_template" rows={2} defaultValue={schedule?.overdue_template ?? ""} placeholder="*{report}* for {date} is overdue." /></label>
      <p className="subtle span-3">Placeholders: {"{group}"} {"{report}"} {"{due_time}"} {"{date}"}. WhatsApp formatting like *bold* works.</p>
      <label><span><input type="checkbox" name="is_active" defaultChecked={schedule?.is_active ?? true} /> Active</span></label>
      <div className="form-actions span-2 align-right"><SubmitButton className="button primary">{schedule ? "Save schedule" : "Add schedule"}</SubmitButton></div>
    </form>
  );
}

async function ReportsTab({ companyId, groups, groupIds, reportTypes, canEdit }: { companyId: string; groups: GroupRow[]; groupIds: string[]; reportTypes: ReportTypeRow[]; canEdit: boolean }) {
  const schedules = groupIds.length
    ? ((await reportBotDb().from("report_bot_schedules").select("*").eq("company_id", companyId).in("group_id", groupIds).order("due_time")).data ?? []) as ScheduleRow[]
    : [];
  const groupLabel = new Map(groups.map((group) => [group.id, group.group_name ?? group.wa_group_id]));
  const reportLabel = new Map(reportTypes.map((report) => [report.id, report.name]));
  return (
    <>
      <section className="panel">
        <div className="panel-head"><div><h2>Report types</h2><p className="subtle">What each report image must show. The AI checks every rule and explains any that fail.</p></div></div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {reportTypes.map((report) => (
            <details key={report.id} className="panel" style={{ margin: 0 }}>
              <summary className="panel-body" style={{ cursor: "pointer" }}><strong>{report.name}</strong> <span className="subtle">· {report.rules.length} rules{report.is_active ? "" : " · inactive"}</span></summary>
              <div className="panel-body">{canEdit ? <ReportTypeForm report={report} /> : <ul className="subtle-list">{report.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}</div>
            </details>
          ))}
          {!reportTypes.length ? <p className="subtle">No report types yet.</p> : null}
          {canEdit ? <details className="panel" style={{ margin: 0 }} open={!reportTypes.length}><summary className="panel-body" style={{ cursor: "pointer" }}><strong>+ Add report type</strong></summary><div className="panel-body"><ReportTypeForm /></div></details> : null}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Schedules</h2><p className="subtle">When each group must post each report, and when the bot reminds them. Times use the time zone in Settings.</p></div></div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {schedules.map((schedule) => (
            <details key={schedule.id} className="panel" style={{ margin: 0 }}>
              <summary className="panel-body" style={{ cursor: "pointer" }}>
                <strong>{groupLabel.get(schedule.group_id)}</strong> · {reportLabel.get(schedule.report_type_id)} · due {formatClock(schedule.due_time)}
                <span className="subtle"> · {schedule.days_of_week.map((day) => DAY_NAMES[day]).join(" ")} · reminders {schedule.reminder_times.map(formatClock).join(", ") || "none"}{schedule.is_active ? "" : " · paused"}</span>
              </summary>
              {canEdit ? <div className="panel-body"><ScheduleForm schedule={schedule} groups={groups} reportTypes={reportTypes} /></div> : null}
            </details>
          ))}
          {!schedules.length ? <p className="subtle">No schedules yet.</p> : null}
          {canEdit ? (
            groups.length && reportTypes.length
              ? <details className="panel" style={{ margin: 0 }} open={!schedules.length}><summary className="panel-body" style={{ cursor: "pointer" }}><strong>+ Add schedule</strong></summary><div className="panel-body"><ScheduleForm groups={groups} reportTypes={reportTypes} /></div></details>
              : <p className="subtle">Add a group (Groups tab) and a report type first.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}

function ConnectionTab({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  return (
    <>
      <section className="panel">
        <div className="panel-head"><div><h2>1 · Worker</h2><p className="subtle">The always-on service that holds the WhatsApp link. Deploy it from workers/whatsapp-report-bot, then enter its address and token here.</p></div></div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <form action={saveWorkerUrl} className="form-grid three">
            <label className="span-2">Worker address<input className="field" name="worker_url" defaultValue={settings.worker_url ?? ""} placeholder="https://wa-bot.dropxlogistics.com" required disabled={!canEdit} /></label>
            <div className="form-actions align-right">{canEdit ? <SubmitButton className="button primary">Save address</SubmitButton> : null}</div>
          </form>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>Worker token: {settings.worker_token_hash ? <StatusPill status={`Created ${when(settings.worker_token_created_at, settings.timezone)}`} tone="good" /> : <StatusPill status="Not created" tone="bad" />}</span>
            {canEdit ? <form action={rotateWorkerToken}><SubmitButton className="button secondary">{settings.worker_token_hash ? "Replace token" : "Create token"}</SubmitButton></form> : null}
          </div>
          <p className="subtle">On the worker set PORTAL_URL to this portal&apos;s address (https://ops.dropxlogistics.com) and WORKER_TOKEN to the token.</p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>2 · WhatsApp number</h2><p className="subtle">Link any WhatsApp account as a linked device, for example your own number for testing. To switch numbers later, unlink here and link the new one. Groups, schedules and history are kept.</p></div></div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {canEdit ? <ReportBotConnection initial={{ state: settings.connection_state, number: settings.connected_number, name: settings.connected_name, error: settings.connection_error }} /> : (
            <p>{settings.connected_number ? `Linked: +${settings.connected_number}` : "Not linked"}</p>
          )}
          {canEdit ? (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <form action={connectWhatsApp}><input type="hidden" name="method" value="qr" /><SubmitButton className="button primary">Link with QR code</SubmitButton></form>
              <form action={connectWhatsApp} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <input type="hidden" name="method" value="code" />
                <label>Number with country code<input className="field" name="phone" inputMode="numeric" placeholder="919876543210" /></label>
                <SubmitButton className="button secondary">Link with code</SubmitButton>
              </form>
              <form action={disconnectWhatsApp}><SubmitButton className="button secondary">Unlink / switch number</SubmitButton></form>
            </div>
          ) : null}
          <p className="subtle">While testing with a personal number, the bot only reads images from groups you enable under Groups. It never reads private chats. Your own images are ignored unless &quot;Analyse my own messages&quot; is on in Settings.</p>
        </div>
      </section>
    </>
  );
}

function SettingsTab({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head"><div><h2>Settings</h2><p className="subtle">Everything the bot does is controlled here. Changes apply on the next minute.</p></div></div>
      <div className="panel-body">
        <form action={saveBotSettings} className="form-grid three">
          <fieldset disabled={!canEdit} className="span-3" style={{ border: 0, padding: 0, display: "contents" }}>
            <label>Mode
              <select className="field" name="mode" defaultValue={settings.mode}>
                <option value="off">Off: not listening</option>
                <option value="listen">Listen only: analyse, never send</option>
                <option value="live">Live: send reminders and feedback</option>
              </select>
            </label>
            <label>Time zone<input className="field" name="timezone" defaultValue={settings.timezone} required /></label>
            <label>Feedback language<input className="field" name="feedback_language" defaultValue={settings.feedback_language} required maxLength={40} /></label>
            <div className="span-3 section-divider"><strong>AI</strong><span>The API key itself is a deployment secret ({aiKeyName(settings.ai_provider)}), never stored here.</span></div>
            <label>Provider
              <select className="field" name="ai_provider" defaultValue={settings.ai_provider}>
                <option value="gemini">Google Gemini (free tier)</option>
                <option value="anthropic">Anthropic Claude (paid)</option>
                <option value="openai">OpenAI (paid)</option>
              </select>
            </label>
            <label>Model<input className="field" name="ai_model" defaultValue={settings.ai_model} required maxLength={100} list="report-bot-models" /></label>
            <datalist id="report-bot-models">
              <option value="gemini-3.8-flash">Gemini, free tier, best quality</option>
              <option value="gemini-3.5-flash-lite">Gemini, free tier, faster with a higher daily limit</option>
              <option value="claude-opus-5-5">Claude, paid</option>
            </datalist>
            <p className="subtle span-3">Gemini&apos;s free tier costs nothing but has daily request limits (images over the limit are retried later), and Google may use free-tier images to improve its products. Use a paid provider if report images must stay private.</p>
            <label>Effort
              <select className="field" name="ai_effort" defaultValue={settings.ai_effort}>
                <option value="low">Low (faster, cheaper)</option>
                <option value="medium">Medium</option>
                <option value="high">High (more careful)</option>
              </select>
            </label>
            <div className="span-3 section-divider"><strong>Sending</strong><span>Manual approval is recommended until the readings are trusted.</span></div>
            <label>Approval
              <select className="field" name="approval_mode" defaultValue={settings.approval_mode}>
                <option value="manual">Approve every reply</option>
                <option value="auto">Auto-send confident results</option>
              </select>
            </label>
            <label>Auto-send minimum confidence (0.5–1)<input className="field" name="auto_send_min_confidence" type="number" step="0.01" min="0.5" max="1" defaultValue={settings.auto_send_min_confidence} required /></label>
            <label>Gap between bot messages in a group (seconds)<input className="field" name="group_min_gap_seconds" type="number" min="0" max="3600" defaultValue={settings.group_min_gap_seconds} required /></label>
            <label>Reply delay minimum (seconds)<input className="field" name="reply_delay_min_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_min_seconds} required /></label>
            <label>Reply delay maximum (seconds)<input className="field" name="reply_delay_max_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_max_seconds} required /></label>
            <label>Skip reminders later than (minutes)<input className="field" name="max_reminder_delay_minutes" type="number" min="1" max="1440" defaultValue={settings.max_reminder_delay_minutes} required /></label>
            <div className="span-3 section-divider"><strong>Feedback message</strong><span>Placeholders: {"{report}"} {"{sender}"} {"{group}"} {"{date}"} {"{verdict_label}"} {"{feedback}"}</span></div>
            <label className="span-3">Message layout<textarea className="field" name="feedback_template" rows={3} defaultValue={settings.feedback_template} required maxLength={1000} /></label>
            <label>Pass label<input className="field" name="label_pass" defaultValue={settings.label_pass} required maxLength={80} /></label>
            <label>Fail label<input className="field" name="label_fail" defaultValue={settings.label_fail} required maxLength={80} /></label>
            <label>Review label<input className="field" name="label_review" defaultValue={settings.label_review} required maxLength={80} /></label>
            <label>Maximum reply length (characters)<input className="field" name="max_feedback_chars" type="number" min="100" max="3000" defaultValue={settings.max_feedback_chars} required /></label>
            <div className="span-3 section-divider"><strong>Testing and edge cases</strong></div>
            <label className="span-3"><span><input type="checkbox" name="include_own_messages" defaultChecked={settings.include_own_messages} /> Analyse my own messages (for testing with your own number; the bot&apos;s own replies are always ignored)</span></label>
            <label className="span-3"><span><input type="checkbox" name="accept_without_request" defaultChecked={settings.accept_without_request} /> Also check images on days with no scheduled report</span></label>
            {canEdit ? <div className="form-actions span-3 align-right"><SubmitButton className="button primary">Save settings</SubmitButton></div> : null}
          </fieldset>
        </form>
      </div>
    </section>
  );
}
