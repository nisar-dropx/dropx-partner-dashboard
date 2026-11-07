import { DispatchForm, type Schedule } from "./dispatch-form";
import type { ComponentProps } from "react";
import { reportBotWorkspace, reportBotPage, reportBotHref, reportBotSetupHref, reportBotChatHref, type ReportBotWorkspace } from "@/lib/report-bot/workspace";
import { loadCodLocations, locationModelName } from "@/lib/ops-pulse/cod";

import { ReportTable } from "@/components/report-table";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  FileText,
  HelpCircle,
  Inbox,
  RefreshCw,
  Send,
  Server,
  Settings2,
  Smartphone,
  Sparkles,
  Users,
  XCircle
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ActionButton } from "@/components/report-bot-controls";
import { LastMileGroupDirectory } from "@/components/last-mile-group-directory";
import { GroupPicker } from "@/components/report-bot-group-picker";
import { ReportThumb, ViewImageButton } from "@/components/report-bot-image-viewer";
import { ReminderTimesField } from "@/components/report-bot-reminder-times";
import { hasPermission, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { canSeeGroup } from "@/lib/report-bot/access";
import { formatClock, localClock, type AnalysisCheck, type ExtractedField } from "@/lib/report-bot/logic";
import { aiKeyConfigured, aiKeyName, aiProviderLabel, loadReportBotSettings, reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import {
  approveFeedback,
  approveReviewItem,
  closeOpenAction,
  dismissReviewItem,
  duplicateGroupConfiguration,
  installLastMileTemplates,
  installTcc3Templates,
  previewScheduleReminders,
  reanalyseSubmission,
  rejectFeedback,
  removeGroup,
  saveGroupSelection,
  saveReportType,
  saveSchedule,
  seedDraftSchedulesForGroup,
  seedLastMileSchedulesForGroup,
  sendAllWaiting,
  sendTestReminder,
  setAutoReply,
  setGroupMode,
  setRequestStatus,
  updateGroup
} from "./actions";
import s from "./report-bot.module.css";
import { Badge, Card, Empty, Field, FlashMessage, MigrationWarning, loadSetupSteps, ReportBotNav, SETUP_HREF, StatusBadge, Toggle, VERDICT, when, sender, workerIsOnline, type Tone } from "./ui";

export const dynamic = "force-dynamic";
// "Approve and send" posts straight away inside the action, which needs more than the default time.
export const maxDuration = 60;

const TABS = [
  { key: "today", label: "Today", icon: CalendarCheck },
  { key: "review", label: "Review", icon: Inbox },
  { key: "actions", label: "Open actions", icon: AlertTriangle },
  { key: "summary", label: "Site summary", icon: FileText },
  { key: "groups", label: "Groups", icon: Users },
  { key: "reports", label: "Reports & schedules", icon: FileText }
] as const;
type Tab = (typeof TABS)[number]["key"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GROUP_MODE_LABEL: Record<string, string> = { observe: "Observe", review: "Review", live: "Live" };

type GroupRow = {
  id: string; wa_group_id: string; group_name: string | null; participant_count: number | null; location_id: string | null;
  is_enabled: boolean; bot_in_group: boolean; mode?: string; workspace?: ReportBotWorkspace;
};
type ReportTypeRow = {
  id: string; name: string; description: string | null; rules: string[]; is_active: boolean;
  slug?: string | null; category?: string | null; auto_reply_policy?: string | null; subtypes?: string[] | null;
};
type ScheduleRow = {
  id: string; group_id: string; report_type_id: string; days_of_week: number[]; reminder_times: string[]; due_time: string;
  first_reminder_template: string; followup_template: string; overdue_template: string | null; is_active: boolean;
  stop_when_received: boolean; schedule_kind?: string | null; review_only?: boolean | null;
};
type SubmissionRow = {
  id: string; group_id: string; sender_name: string | null; sender_jid: string | null; caption: string | null; message_at: string;
  status: string; status_reason: string | null; verdict: string | null; confidence: number | null; feedback_text: string | null;
  media_ref: string | null; report_type_id: string | null;
  ai_result: { checks?: AnalysisCheck[]; extracted_summary?: string; extracted_fields?: ExtractedField[] } | null;
};
type Lookup = { groupName: Map<string, string>; reportName: Map<string, string> };

function tabHref(tab: Tab, workspace: ReportBotWorkspace) {
  return reportBotHref(workspace, tab);
}
function BotForm({ workspace, children, ...props }: ComponentProps<"form"> & { workspace: ReportBotWorkspace }) {
  return <form {...props}><input type="hidden" name="workspace" value={workspace} />{children}</form>;
}

export default async function ReportBotPage({ searchParams }: { searchParams?: { tab?: string; workspace?: string } }) {
  const workspace = reportBotWorkspace(searchParams?.workspace);
  const pageCode = reportBotPage(workspace);
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, pageCode, "edit");
  // Old links to the moved tabs land on the setup page instead of a blank tab.
  const requested = searchParams?.tab;
  if (requested === "connection" || requested === "settings") redirect(reportBotSetupHref(workspace));
  if (requested === "chats") redirect(reportBotChatHref(workspace));
  const tab: Tab = TABS.find((entry) => entry.key === requested)?.key ?? "today";
  const db = reportBotDb();

  let settings: ReportBotSettings;
  try {
    settings = await loadReportBotSettings(companyId);
  } catch (error) {
    return (
      <AppShell active="Report Bot" pageCode={pageCode}>
        <div className={s.page}>
          <div className={`${s.flash} ${s.flashError}`} role="alert">
            <AlertTriangle size={18} aria-hidden />
            <div><strong>Report Bot isn&apos;t set up in the database yet</strong>{error instanceof Error ? error.message : "Unavailable"}. Apply the Report Bot migrations, then reload.</div>
          </div>
        </div>
      </AppShell>
    );
  }

  const [groupsResult, reportTypesResult, steps] = await Promise.all([
    db.from("report_bot_groups").select("*").eq("company_id", companyId).eq("workspace", workspace).order("group_name"),
    db.from("report_bot_report_types").select("*").eq("company_id", companyId).eq("workspace", workspace).order("name"),
    loadSetupSteps(settings)
  ]);
  const groups = ((groupsResult.data ?? []) as GroupRow[]).filter((group) => canSeeGroup(authorization, group));
  const groupIds = groups.map((group) => group.id);
  const dispatch = workspace === "last_mile" && tab === "reports" && groupIds.length
    ? await db.from("report_bot_lm_dispatch_routes").select("*").eq("company_id",companyId).in("group_id",groupIds).order("report") : {data:[],error:null};
  const dispatchRoutes = (dispatch.data ?? []) as Schedule[];
  const deliveries = dispatchRoutes.length ? await db.from("report_bot_lm_dispatch_runs").select("route_id,day,slot,status,detail").in("route_id",dispatchRoutes.map(r=>r.id)).order("created_at",{ascending:false}).limit(25) : {data:[],error:null};
  const reportTypes = (reportTypesResult.data ?? []) as ReportTypeRow[];
  const [schedulesResult, waitingCount, attentionCount] = groupIds.length ? await Promise.all([
    db.from("report_bot_schedules").select("*").eq("company_id", companyId).in("group_id", groupIds).order("due_time"),
    db.from("report_bot_submissions").select("id", { head: true, count: "exact" }).eq("company_id", companyId).in("group_id", groupIds).eq("status", "awaiting_approval"),
    db.from("report_bot_submissions").select("id", { head: true, count: "exact" }).eq("company_id", companyId).in("group_id", groupIds).in("status", ["failed", "blocked"])
  ]) : [{ data: [] }, { count: 0 }, { count: 0 }];
  const schedules = (schedulesResult.data ?? []) as ScheduleRow[];
  const lookup: Lookup = {
    groupName: new Map(groups.map((group) => [group.id, group.group_name ?? "Unnamed group"])),
    reportName: new Map(reportTypes.map((report) => [report.id, report.name]))
  };

  const aiReady = aiKeyConfigured(settings.ai_provider);
  const workerOnline = workerIsOnline(settings);
  const linked = settings.connection_state === "open";
  const doneSteps = steps.filter((step) => step.done).length;
  const modeTone: Tone = settings.mode === "live" ? "good" : settings.mode === "listen" ? "info" : "neutral";
  const modeLabel = settings.mode === "live" ? "Live" : settings.mode === "listen" ? "Listen only" : "Off";

  return (
    <AppShell active="Report Bot" pageCode={pageCode}>
      <div className={s.page}>
        <header className={s.hero}>
          <div>
            <span className={s.eyebrow}><Bot size={13} aria-hidden /> Ops Pulse · {workspace === "last_mile" ? "Last Mile" : "Dark Store"}</span>
            <h1>Report Bot</h1>
            <p>{workspace === "last_mile" ? "Last Mile reports, groups and schedules · same WhatsApp as Dark Store Report Bot." : "Report checks, reminders and reviewed replies for Dark Store groups."}</p>
          </div>
          <div className={s.formActions}>
            <Badge tone={modeTone} className={s.modeBadge}>{modeLabel}</Badge>
            <Link className={s.button} href={reportBotSetupHref(workspace)}><Settings2 size={15} aria-hidden />Setup</Link>
          </div>
        </header>

        {workspace === "last_mile" ? <div className={s.flash}><Smartphone size={16} /><span>{linked ? `Shared WhatsApp connected${settings.connected_number ? ` · +${settings.connected_number}` : ""}` : "Shared WhatsApp not connected — link it in Dark Store Report Bot setup"} · New groups start in Observe.</span></div> : <div className={s.tiles}>
          <Link className={s.tile} href={`${SETUP_HREF}#mode`}>
            <span className={`${s.tileIcon} ${settings.mode === "live" ? s.good : settings.mode === "listen" ? s.warn : ""}`}><Bot size={15} aria-hidden /></span>
            <span><span className={s.tileLabel}>Mode</span><div className={s.tileValue}>{modeLabel}</div><div className={s.tileHint}>{settings.mode === "live" ? "Sends reminders and replies" : settings.mode === "listen" ? "Checks photos, sends nothing" : "Not listening to groups"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#whatsapp`}>
            <span className={`${s.tileIcon} ${s[linked ? "good" : "bad"]}`}><Smartphone size={15} aria-hidden /></span>
            <span><span className={s.tileLabel}>WhatsApp</span><div className={s.tileValue}>{linked ? "Connected" : "Not linked"}</div><div className={s.tileHint}>{settings.connected_number ? `+${settings.connected_number}` : "Link a number to start"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#worker`}>
            <span className={`${s.tileIcon} ${s[workerOnline ? "good" : settings.last_worker_seen_at ? "warn" : "bad"]}`}><Server size={15} aria-hidden /></span>
            <span><span className={s.tileLabel}>Worker</span><div className={s.tileValue}>{workerOnline ? "Online" : settings.last_worker_seen_at ? "Not responding" : "Not started"}</div><div className={s.tileHint}>{settings.last_worker_seen_at ? `Last seen ${when(settings.last_worker_seen_at, settings.timezone)}` : "Start it from Setup"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#ai`}>
            <span className={`${s.tileIcon} ${s[aiReady ? "good" : "bad"]}`}><Sparkles size={15} aria-hidden /></span>
            <span><span className={s.tileLabel}>AI check</span><div className={s.tileValue}>{aiReady ? `${aiProviderLabel(settings.ai_provider)} ready` : "Key missing"}</div><div className={s.tileHint}>{aiReady ? settings.ai_model : `Add ${aiKeyName(settings.ai_provider)} in Vercel`}</div></span>
          </Link>
        </div>}

        {workspace === "dark_store" && doneSteps < steps.length ? (
          <div className={s.setupBanner}>
            <span><strong>Setup {doneSteps} of {steps.length} done.</strong> Finish it to start receiving report checks.</span>
            <Link className={`${s.button} ${s.primary} ${s.small}`} href={SETUP_HREF}>Finish setup<ChevronRight size={14} aria-hidden /></Link>
          </div>
        ) : null}

        {await MigrationWarning()}
        {workspace === "dark_store" ? <div className={`${s.flash} ${s.flashSuccess} ${s.flashCompact}`} role="note">
          <Bot size={14} aria-hidden />
          <div>
            <strong>Pilot:</strong>
            Use <strong>Testing</strong> only. Do not enable or message <strong>TCC3 · Adayar</strong> until Duplicate configuration after Observe → Review. Private chats are never read.
          </div>
        </div> : null}
        <FlashMessage />

        <ReportBotNav workspace={workspace} active={tab === "actions" || tab === "summary" ? "review" : tab} waiting={waitingCount.count ?? 0} attention={attentionCount.count ?? 0} />
        <div className={s.formActions} style={{ marginBottom: 8 }}>
          {workspace === "last_mile" && <Link className={s.button+" "+s.small} href={reportBotHref(workspace,"groups")}>Choose WhatsApp groups</Link>}
          {workspace === "last_mile" && <Link className={s.button+" "+s.small} href={reportBotChatHref(workspace)}>Open group chats</Link>}
          {workspace === "last_mile" && <Link className={s.button+" "+s.small} href={reportBotHref(workspace,"reports")+"#dispatch"}>Schedule WhatsApp reports</Link>}
          <Link className={`${s.button} ${s.small} ${tab === "actions" ? s.primary : ""}`} href={reportBotHref(workspace, "actions")}>Open actions</Link>
          <Link className={`${s.button} ${s.small} ${tab === "summary" ? s.primary : ""}`} href={reportBotHref(workspace, "summary")}>Daily site summary</Link>
        </div>

        {tab === "today" ? await TodayTab({ workspace, companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "review" ? await ReviewTab({ workspace, companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "actions" ? await ActionsTab({ workspace, companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "summary" ? await SummaryTab({ workspace, companyId, groupIds, lookup, settings }) : null}
        {tab === "groups" ? await GroupsTab({ workspace, authorization, groups, canEdit }) : null}
        {workspace === "last_mile" && tab === "reports" && <>
          {dispatch.error || deliveries.error ? <p role="alert">Could not load outbound schedules or delivery history.</p> : null}
          <DispatchForm canEdit={canEdit} schedules={dispatchRoutes} groups={groups.map(g=>({id:g.id,name:g.group_name || g.wa_group_id,mode:g.mode || "observe",mapped:Boolean(g.location_id && g.is_enabled && g.bot_in_group)}))}/>
          {deliveries.data?.length ? <details className={s.cardBody}><summary>Recent dispatches</summary>{deliveries.data.map(r=><p key={r.route_id+r.day+r.slot}>{groups.find(g=>g.id===dispatchRoutes.find(d=>d.id===r.route_id)?.group_id)?.group_name} · {r.day} {r.slot} IST · {r.status} · {r.detail}</p>)}</details> : null}
        </>}
        {tab === "reports" ? <ReportsTab workspace={workspace} groups={groups} reportTypes={reportTypes} schedules={schedules} lookup={lookup} canEdit={canEdit} /> : null}
      </div>
    </AppShell>
  );
}

async function TodayTab({ workspace, companyId, groupIds, lookup, settings, canEdit }: { workspace: ReportBotWorkspace; companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings; canEdit: boolean }) {
  const date = localClock(new Date(), settings.timezone).date;
  const db = reportBotDb();
  const [requests, submissions] = groupIds.length ? await Promise.all([
    db.from("report_bot_requests").select("*, schedule:report_bot_schedules(due_time,reminder_times)").eq("company_id", companyId).eq("business_date", date).in("group_id", groupIds).order("created_at"),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).gte("message_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order("message_at", { ascending: false }).limit(100)
  ]) : [{ data: [] }, { data: [] }];
  const rows = (requests.data ?? []) as Array<{
    id: string; group_id: string; report_type_id: string; status: string; reminders_sent: number; received_at: string | null; last_verdict: string | null;
    schedule: { due_time: string; reminder_times: string[] } | null;
  }>;
  const images = (submissions.data ?? []) as SubmissionRow[];
  const received = rows.filter((row) => row.status === "received").length;
  const overdue = rows.filter((row) => row.status === "overdue").length;
  return (
    <>
      <div className={s.kpis}>
        <div className={s.kpi}><span>Due today</span><strong>{rows.length}</strong><small>Across your groups</small></div>
        <div className={s.kpi}><span>Received</span><strong>{received}</strong><small>{rows.length ? `${Math.round((received / rows.length) * 100)}% of today's reports` : "Nothing due yet"}</small></div>
        <div className={s.kpi}><span>Overdue</span><strong>{overdue}</strong><small>Past the due time</small></div>
        <div className={s.kpi}><span>Photos (24h)</span><strong>{images.length}</strong><small>{images.filter((row) => row.status === "awaiting_approval").length} waiting for review</small></div>
      </div>
      <Card title="Today's reports" icon={<CalendarCheck size={18} aria-hidden />} description="One row per group and report due today. Reminders stop as soon as the report photo arrives." flush>
        {rows.length ? (
          <div className={s.tableWrap}>
            <ReportTable className={`${s.table} ${s.dueReports}`}>
              <thead><tr><th>Group</th><th>Report</th><th>Due</th><th>Reminders</th><th>Status</th><th>Result</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
              <tbody>
                {rows.map((row) => {
                  const verdict = row.last_verdict ? VERDICT[row.last_verdict] : null;
                  return (
                    <tr key={row.id}>
                      <td data-label="Group" className={s.cellTitle}>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                      <td data-label="Report">{lookup.reportName.get(row.report_type_id) ?? "—"}</td>
                      <td data-label="Due">{row.schedule ? formatClock(row.schedule.due_time) : "—"}</td>
                      <td data-label="Reminders">{row.reminders_sent} of {row.schedule?.reminder_times?.length ?? 0}</td>
                      <td data-label="Status"><StatusBadge value={row.status} />{row.received_at ? <span className={s.cellSub}>{when(row.received_at, settings.timezone)}</span> : null}</td>
                      <td data-label="Result">{verdict ? <Badge tone={verdict[1]}>{verdict[0]}</Badge> : "—"}</td>
                      {canEdit ? (
                        <td data-label="Actions" className={s.dueActions}>
                          <div className={s.rowActions}>
                            {["pending", "overdue"].includes(row.status) ? (
                              <>
                                <BotForm workspace={workspace} action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="received" /><ActionButton className={`${s.button} ${s.small}`}>Mark received</ActionButton></BotForm>
                                <BotForm workspace={workspace} action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="cancelled" /><ActionButton className={`${s.button} ${s.small} ${s.ghost}`} confirm="Cancel today's reminders for this group?">Skip today</ActionButton></BotForm>
                              </>
                            ) : row.status === "cancelled" ? (
                              <BotForm workspace={workspace} action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="pending" /><ActionButton className={`${s.button} ${s.small}`}>Reopen</ActionButton></BotForm>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </ReportTable>
          </div>
        ) : (
          <Empty icon={<CalendarCheck size={28} aria-hidden />} title={settings.mode === "off" ? "The bot is off" : "Nothing due today"}>
            {settings.mode === "off" ? <>Turn on <Link href={`${SETUP_HREF}#mode`}>Listen only</Link> to start tracking reports.</> : <>Reports appear here on days that have a <Link href={tabHref("reports", workspace)}>schedule</Link>.</>}
          </Empty>
        )}
      </Card>
      {await BotMessagesToday({ companyId, groupIds, lookup, timeZone: settings.timezone })}
      <SubmissionTable rows={images} lookup={lookup} timeZone={settings.timezone} title="Photos in the last 24 hours" emptyText="No report photos have been posted in your groups in the last 24 hours." />
    </>
  );
}

const MESSAGE_KIND: Record<string, string> = { reminder: "Reminder", followup: "Follow-up reminder", overdue: "Overdue notice", feedback: "Review reply" };
const MESSAGE_STATUS: Record<string, [string, Tone]> = {
  sent: ["Posted", "good"],
  pending: ["Waiting to post", "info"],
  cancelled: ["Not posted", "neutral"],
  failed: ["Failed", "bad"]
};

/** Every reminder and reply the bot queued in the last 24 hours, and what happened to it. */
async function BotMessagesToday({ companyId, groupIds, lookup, timeZone }: { companyId: string; groupIds: string[]; lookup: Lookup; timeZone: string }) {
  const result = groupIds.length
    ? await reportBotDb().from("report_bot_outbox").select("id,group_id,kind,status,status_reason,not_before,sent_at,created_at,dedupe_key,body")
      .eq("company_id", companyId).in("group_id", groupIds).gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("created_at", { ascending: false }).limit(100)
    : { data: [] };
  const rows = (result.data ?? []) as Array<{
    id: string; group_id: string; kind: string; status: string; status_reason: string | null; not_before: string; sent_at: string | null; created_at: string; dedupe_key: string; body: string;
  }>;
  return (
    <Card title="Bot messages in the last 24 hours" icon={<Send size={18} aria-hidden />} description="Each reminder and reply the bot queued, and whether it was posted. A reminder that wasn't posted shows why (for example, the report had already arrived)." flush action={<span className={`${s.count} ${s.countMuted}`}>{rows.length}</span>}>
      {rows.length ? (
        <div className={s.tableWrap}>
          <ReportTable className={s.table}>
            <thead><tr><th>Queued</th><th>Group</th><th>Message</th><th>Status</th><th>Posted</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const [label, tone] = MESSAGE_STATUS[row.status] ?? [row.status, "neutral" as Tone];
                return (
                  <tr key={row.id}>
                    <td>{when(row.created_at, timeZone)}</td>
                    <td className={s.cellTitle}>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                    <td>
                      {row.dedupe_key.startsWith("test:") ? "Test reminder" : MESSAGE_KIND[row.kind] ?? row.kind}
                      <span className={s.cellSub}>{row.body.length > 90 ? `${row.body.slice(0, 89)}…` : row.body}</span>
                    </td>
                    <td><Badge tone={tone}>{label}</Badge>{row.status_reason ? <span className={s.cellSub}>{row.status_reason}</span> : null}</td>
                    <td>{row.sent_at ? when(row.sent_at, timeZone) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </ReportTable>
        </div>
      ) : <Empty icon={<Send size={28} aria-hidden />} title="No bot messages yet">Reminders and replies appear here when they are queued.</Empty>}
    </Card>
  );
}

function SubmissionTable({ rows, lookup, timeZone, title, emptyText }: { rows: SubmissionRow[]; lookup: Lookup; timeZone: string; title: string; emptyText: string }) {
  return (
    <Card title={title} icon={<Inbox size={18} aria-hidden />} flush action={<span className={`${s.count} ${s.countMuted}`}>{rows.length}</span>}>
      {rows.length ? (
        <div className={s.tableWrap}>
          <ReportTable className={s.table}>
            <thead><tr><th>Time</th><th>Group</th><th>Sender</th><th>Report</th><th>Status</th><th>Result</th><th><span className="sr-only">Image</span></th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const verdict = row.verdict ? VERDICT[row.verdict] : null;
                return (
                  <tr key={row.id}>
                    <td>{when(row.message_at, timeZone)}</td>
                    <td className={s.cellTitle}>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                    <td>{sender(row)}</td>
                    <td>{row.report_type_id ? lookup.reportName.get(row.report_type_id) ?? "—" : "—"}</td>
                    <td><StatusBadge value={row.status} />{row.status_reason ? <span className={s.cellSub}>{row.status === "queued" ? `Retrying automatically: ${row.status_reason}` : row.status_reason}</span> : null}</td>
                    <td>{verdict ? <Badge tone={verdict[1]}>{verdict[0]}</Badge> : "—"}</td>
                    <td>{row.media_ref ? <ViewImageButton submissionId={row.id} title={`Photo from ${sender(row)}`} className={`${s.button} ${s.small} ${s.ghost}`}>View</ViewImageButton> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </ReportTable>
        </div>
      ) : <Empty icon={<Inbox size={28} aria-hidden />} title="No photos yet">{emptyText}</Empty>}
    </Card>
  );
}

function CheckList({ checks }: { checks: AnalysisCheck[] }) {
  return (
    <ul className={s.checks}>
      {checks.map((item, index) => (
        <li key={index}>
          {item.status === "pass" ? <CheckCircle2 size={16} className={s.checkPass} aria-label="Passed" />
            : item.status === "fail" ? <XCircle size={16} className={s.checkFail} aria-label="Failed" />
              : <HelpCircle size={16} className={s.checkUnclear} aria-label="Unclear" />}
          <span>{item.rule}{item.note ? <span className={s.checkNote}> — {item.note}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

async function ReviewTab({ workspace, companyId, groupIds, lookup, settings, canEdit }: { workspace: ReportBotWorkspace; companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings; canEdit: boolean }) {
  const db = reportBotDb();
  const [waiting, attention, recent, reviewItems] = groupIds.length ? await Promise.all([
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).eq("status", "awaiting_approval").order("message_at").limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["failed", "blocked"]).order("message_at", { ascending: false }).limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["sent", "ignored", "rejected", "skipped", "queued_to_send"]).order("message_at", { ascending: false }).limit(30),
    db.from("report_bot_review_items").select("*").eq("company_id", companyId).in("group_id", groupIds).in("review_status", ["observe_only", "draft_ready"]).order("created_at", { ascending: false }).limit(50)
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [], error: null }];
  const waitingRows = (waiting.data ?? []) as SubmissionRow[];
  const attentionRows = (attention.data ?? []) as SubmissionRow[];
  const reviewRows = (reviewItems.error ? [] : (reviewItems.data ?? [])) as Array<{
    id: string; group_id: string; review_status: string; verdict: string | null; confidence: number | null; reason: string | null;
    feedback_draft: string | null; report_type_id: string | null; extracted_facts: Array<{ label: string; value: string }> | null;
    submission_id: string | null; created_at: string;
  }>;
  const auto = settings.approval_mode === "auto";
  return (
    <>
      <Card title="Review queue" icon={<Inbox size={18} aria-hidden />} description="Inbound operational messages and evidence with classification, facts and a feedback draft. Observe mode never sends; Review mode requires approval.">
        {reviewRows.length ? (
          <div className={s.reviewList}>
            {reviewRows.map((row) => {
              const verdict = VERDICT[row.verdict ?? "needs_review"] ?? VERDICT.needs_review;
              return (
                <article key={row.id} className={s.reviewCard}>
                  <div className={s.reviewMain}>
                    <div className={s.reviewMeta}>
                      <strong>{lookup.groupName.get(row.group_id) ?? "Group"}</strong>
                      <Badge tone={row.review_status === "draft_ready" ? "warn" : "info"}>{row.review_status}</Badge>
                      {row.report_type_id ? <Badge tone="neutral">{lookup.reportName.get(row.report_type_id)}</Badge> : null}
                      <Badge tone={verdict[1]}>{verdict[0]}</Badge>
                    </div>
                    {row.reason ? <p className={s.summary}>{row.reason}</p> : null}
                    {row.extracted_facts?.length ? (
                      <dl className={s.facts}>
                        {row.extracted_facts.map((item, index) => [<dt key={`l${index}`}>{item.label}</dt>, <dd key={`v${index}`}>{item.value}</dd>])}
                      </dl>
                    ) : null}
                    {canEdit && row.review_status === "draft_ready" ? (
                      <BotForm workspace={workspace} action={approveReviewItem} className={s.reply}>
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Feedback draft">
                          <textarea className={s.textarea} name="feedback_text" rows={3} defaultValue={row.feedback_draft ?? ""} required maxLength={3000} />
                        </Field>
                        <div className={s.replyActions}>
                          <ActionButton className={`${s.button} ${s.primary}`}><Send size={15} aria-hidden />Approve and send</ActionButton>
                          <ActionButton className={`${s.button} ${s.danger}`} formAction={dismissReviewItem} skipValidation>Dismiss</ActionButton>
                        </div>
                      </BotForm>
                    ) : canEdit ? (
                      <BotForm workspace={workspace} action={dismissReviewItem} className={s.formActions}>
                        <input type="hidden" name="id" value={row.id} />
                        <span className={s.hint}>{row.feedback_draft || "Observe only — no send."}</span>
                        <ActionButton className={`${s.button} ${s.small} ${s.ghost}`}>Dismiss</ActionButton>
                      </BotForm>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <Empty icon={<CheckCircle2 size={28} aria-hidden />} title="Review queue is empty">Classified text and image reports appear here for the Testing pilot.</Empty>}
      </Card>
      {canEdit ? (
        <section className={s.card}>
          <div className={s.reviewBar}>
            <div>
              <strong>Auto-reply is {auto ? "on" : "off"}</strong>
              <div className={s.hint}>
                {auto
                  ? `Confident results (${Math.round(settings.auto_send_min_confidence * 100)}%+, no unclear rule) are posted without a click. Unclear photos still wait below.`
                  : "Every reply waits here for you to approve."}
              </div>
            </div>
            <div className={s.formActions}>
              {waitingRows.some((row) => row.feedback_text?.trim()) ? (
                <BotForm workspace={workspace} action={sendAllWaiting}>
                  <ActionButton className={s.button} confirm={`Post the AI's reply for all ${waitingRows.length} waiting photos?`}><Send size={15} aria-hidden />Send all waiting</ActionButton>
                </BotForm>
              ) : null}
              {workspace === "dark_store" ? <BotForm workspace={workspace} action={setAutoReply}>
                <input type="hidden" name="auto" value={auto ? "off" : "on"} />
                <ActionButton className={`${s.button} ${auto ? "" : s.primary}`}><Sparkles size={15} aria-hidden />{auto ? "Turn auto-reply off" : "Turn auto-reply on"}</ActionButton>
              </BotForm> : null}
            </div>
          </div>
        </section>
      ) : null}
      <Card
        title="Waiting for review"
        icon={<Inbox size={18} aria-hidden />}
        description={settings.mode === "live"
          ? "Compare the AI's reading with the photo, adjust the reply if needed, and approve. It's posted in the group within seconds."
          : "The bot is not Live, so approved replies wait and go out once you switch to Live (within 12 hours)."}
        action={waitingRows.length ? <span className={s.count}>{waitingRows.length}</span> : null}
      >
        {waitingRows.length ? (
          <div className={s.reviewList}>
            {waitingRows.map((row) => {
              const verdict = VERDICT[row.verdict ?? "needs_review"] ?? VERDICT.needs_review;
              const confidence = row.confidence === null ? null : Math.round(Number(row.confidence) * 100);
              return (
                <article key={row.id} className={s.reviewCard}>
                  <ReportThumb submissionId={row.id} alt={`Report photo from ${sender(row)}`} className={s.thumb} missingClassName={s.thumbMissing} />
                  <div className={s.reviewMain}>
                    <div className={s.reviewMeta}>
                      <strong>{lookup.groupName.get(row.group_id) ?? "Group"}</strong>
                      <span>{sender(row)} · {when(row.message_at, settings.timezone)}</span>
                      {row.report_type_id ? <Badge tone="neutral">{lookup.reportName.get(row.report_type_id)}</Badge> : null}
                    </div>
                    <div className={s.reviewMeta}>
                      <Badge tone={verdict[1]}>{verdict[0]}</Badge>
                      {confidence !== null ? (
                        <span className={s.confidence}>
                          <span className={s.confidenceBar} aria-hidden><span style={{ width: `${confidence}%` }} /></span>
                          {confidence}% sure
                        </span>
                      ) : null}
                    </div>
                    {row.ai_result?.extracted_summary ? <p className={s.summary}>{row.ai_result.extracted_summary}</p> : null}
                    {row.caption ? <p className={s.caption}>Caption: “{row.caption}”</p> : null}
                    {row.ai_result?.extracted_fields?.length ? (
                      <dl className={s.facts}>
                        {row.ai_result.extracted_fields.map((item, index) => [
                          <dt key={`l${index}`}>{item.label}</dt>,
                          <dd key={`v${index}`}>{item.value}</dd>
                        ])}
                      </dl>
                    ) : null}
                    {row.ai_result?.checks?.length ? <CheckList checks={row.ai_result.checks} /> : null}
                    {canEdit ? (
                      <BotForm workspace={workspace} action={approveFeedback} className={s.reply}>
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Reply to post in the group" hint="Edit freely. It's posted as a reply to this photo.">
                          <textarea className={s.textarea} name="feedback_text" rows={4} defaultValue={row.feedback_text ?? ""} required maxLength={3000} />
                        </Field>
                        <div className={s.replyActions}>
                          <ActionButton className={`${s.button} ${s.primary}`}><Send size={15} aria-hidden />Approve and send</ActionButton>
                          <ActionButton className={`${s.button} ${s.ghost}`} formAction={reanalyseSubmission} skipValidation><RefreshCw size={15} aria-hidden />Check again</ActionButton>
                          <ActionButton className={`${s.button} ${s.danger}`} formAction={rejectFeedback} skipValidation>Don&apos;t send</ActionButton>
                        </div>
                      </BotForm>
                    ) : <p className={s.hint}>Proposed reply: {row.feedback_text}</p>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <Empty icon={<CheckCircle2 size={28} aria-hidden />} title="All caught up">New report photos that need a decision will appear here.</Empty>}
      </Card>

      {attentionRows.length ? (
        <Card title="Needs attention" icon={<AlertTriangle size={18} aria-hidden />} description="Photos that couldn't be checked, or replies that couldn't be sent. Fix the cause shown, then retry." flush action={<span className={`${s.count} ${s.countMuted}`}>{attentionRows.length}</span>}>
          <div className={s.tableWrap}>
            <ReportTable className={s.table}>
              <thead><tr><th>Time</th><th>Group</th><th>Sender</th><th>Problem</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
              <tbody>
                {attentionRows.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.message_at, settings.timezone)}</td>
                    <td className={s.cellTitle}>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                    <td>{sender(row)}</td>
                    <td><StatusBadge value={row.status} /><span className={s.cellSub}>{row.status_reason}</span></td>
                    {canEdit ? (
                      <td>
                        <BotForm workspace={workspace} action={reanalyseSubmission} className={s.rowActions}>
                          <input type="hidden" name="id" value={row.id} />
                          <ActionButton className={`${s.button} ${s.small}`}><RefreshCw size={14} aria-hidden />Retry</ActionButton>
                          <ActionButton className={`${s.button} ${s.small} ${s.ghost}`} formAction={rejectFeedback}>Dismiss</ActionButton>
                        </BotForm>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </ReportTable>
          </div>
        </Card>
      ) : null}

      <SubmissionTable rows={(recent.data ?? []) as SubmissionRow[]} lookup={lookup} timeZone={settings.timezone} title="Recently handled" emptyText="Handled photos will be listed here." />
    </>
  );
}

async function GroupsTab({ workspace, authorization, groups, canEdit }: { workspace: ReportBotWorkspace; authorization: AuthorizationContext; groups: GroupRow[]; canEdit: boolean }) {
  let stores: Array<{ id: string; station_code: string; station_name: string | null }> = [];
  let storeError: string | null = null;
  try {
    if (workspace === "dark_store") stores = (await darkStoreScope(authorization)).locations;
    else {
      const scope = await loadCodLocations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess);
      if (scope.error) throw new Error("Locations could not be loaded.");
      stores = scope.locations.filter(l => !l.is_ho && !l.hide_from_location_list && locationModelName(l).toUpperCase() !== "NOW");
    }
  } catch (error) {
    storeError = error instanceof Error ? error.message : "Stores could not be loaded.";
  }
  // Only groups ticked in the picker are on the bot and shown here.
  const active = groups.filter((group) => group.is_enabled);
  return (
    <>
    {workspace === "last_mile" && canEdit && <LastMileGroupDirectory stations={stores} />}
    <Card
      title="WhatsApp groups"
      icon={<Users size={18} aria-hidden />}
      description="Observe: classify only · Review: approve replies · Live: automatic eligible replies. Reminders run in Review and Live."
      action={canEdit && workspace === "dark_store" ? <GroupPicker workspace={workspace} action={saveGroupSelection} disabled={!authorization.hasAllLocationAccess} /> : null}
      flush
    >
      {storeError ? <div className={s.cardBody}><p className={s.hint} role="alert">{storeError}</p></div> : null}
      {active.length ? (
        <div className={s.groupList}>
          {active.map((group) => (
            <div key={group.id} className={s.groupRow}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
                <span className={s.avatar} aria-hidden>{(group.group_name ?? "G").slice(0, 1).toUpperCase()}</span>
                <div style={{ minWidth: 0 }}>
                  <div className={s.groupName}>{group.group_name ?? "Unnamed group"}</div>
                  <div className={s.groupMeta}>
                    {group.participant_count ? <span>{group.participant_count} members</span> : null}
                    <Badge tone={group.mode === "live" ? "good" : group.mode === "review" ? "warn" : "info"}>{GROUP_MODE_LABEL[group.mode ?? "observe"] ?? "Observe"}</Badge>
                    {group.bot_in_group ? <Badge tone="good">Listening</Badge> : <Badge tone="bad">Bot number not in group</Badge>}
                    <Link href={reportBotChatHref(workspace, group.id)}>Open chat</Link>
                  </div>
                </div>
              </div>
              {canEdit ? (
                <BotForm workspace={workspace} action={setGroupMode} className={s.inlineForm}>
                  <input type="hidden" name="group_id" value={group.id} />
                  <Field label="Group mode">
                    <select className={s.select} name="mode" defaultValue={group.mode ?? "observe"}>
                      <option value="observe">Observe</option>
                      <option value="review">Review</option>
                      <option value="live">Live</option>
                    </select>
                  </Field>
                  <ActionButton className={`${s.button} ${s.small}`}>Save mode</ActionButton>
                </BotForm>
              ) : null}
              <BotForm workspace={workspace} action={updateGroup} className={s.inlineForm}>
                <input type="hidden" name="group_id" value={group.id} />
                <Field label={workspace === "last_mile" ? "Station" : "Store"}>
                  <select className={s.select} name="location_id" defaultValue={group.location_id ?? ""} disabled={!canEdit}>
                    <option value="">{authorization.hasAllLocationAccess ? "No store linked" : "Choose a store"}</option>
                    {stores.map((store) => <option key={store.id} value={store.id}>{store.station_code}{store.station_name ? ` · ${store.station_name}` : ""}</option>)}
                  </select>
                </Field>
                {canEdit ? <ActionButton className={`${s.button} ${s.small}`}>Save</ActionButton> : null}
              </BotForm>
              {canEdit ? (
                <BotForm workspace={workspace} action={removeGroup}>
                  <input type="hidden" name="group_id" value={group.id} />
                  <ActionButton className={`${s.button} ${s.small} ${s.danger}`} confirm={`Remove "${group.group_name ?? "this group"}" from the bot? It stops listening and posting there; history is kept.`}>Remove</ActionButton>
                </BotForm>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Users size={28} aria-hidden />} title="No groups on the bot yet">
          {workspace === "last_mile" && canEdit ? "Choose a group and its station above." : canEdit ? <>Press <strong>Add or remove groups</strong> and tick the report groups.</> : "An editor adds the report groups here."}
          {workspace === "dark_store" ? <> The WhatsApp number must be <Link href={`${SETUP_HREF}#whatsapp`}>linked</Link> first.</> : <> Uses the existing shared WhatsApp connection.</>}
        </Empty>
      )}
    </Card>
    {canEdit && active.length >= 2 ? (
      <Card title="Duplicate configuration" icon={<Users size={18} aria-hidden />} description="Copy schedules as inactive drafts. Target group stays in Observe.">
        <BotForm workspace={workspace} action={duplicateGroupConfiguration} className={s.formGrid}>
          <Field label="From group">
            <select className={s.select} name="source_group_id" required>
              <option value="">Choose source</option>
              {active.map((group) => <option key={group.id} value={group.id}>{group.group_name ?? "Unnamed"}</option>)}
            </select>
          </Field>
          <Field label="To group">
            <select className={s.select} name="target_group_id" required>
              <option value="">Choose target</option>
              {active.map((group) => <option key={group.id} value={group.id}>{group.group_name ?? "Unnamed"}</option>)}
            </select>
          </Field>
          <div className={s.span3}>
            <ActionButton className={`${s.button} ${s.primary}`} confirm="Copy inactive schedule drafts to the target group and leave it in Observe?">Duplicate configuration</ActionButton>
          </div>
        </BotForm>
      </Card>
    ) : null}
    </>
  );
}

async function ActionsTab({ workspace, companyId, groupIds, lookup, settings, canEdit }: { workspace: ReportBotWorkspace; companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings; canEdit: boolean }) {
  const result = groupIds.length
    ? await reportBotDb().from("report_bot_actions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["open", "pending_evidence", "unmatched_closure"]).order("created_at", { ascending: false }).limit(100)
    : { data: [] };
  const rows = (result.data ?? []) as Array<{
    id: string; group_id: string; title: string; category: string; owner_name: string | null; status: string; high_risk: boolean; created_at: string;
  }>;
  return (
    <Card title="Open actions" icon={<AlertTriangle size={18} aria-hidden />} description="Incidents, shortages, expiry and tickets extracted from the group. Close with confirmation when evidence arrives." flush>
      {rows.length ? (
        <div className={s.tableWrap}>
          <ReportTable className={s.table}>
            <thead><tr><th>Opened</th><th>Group</th><th>Action</th><th>Owner</th><th>Status</th>{canEdit ? <th></th> : null}</tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{when(row.created_at, settings.timezone)}</td>
                  <td>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                  <td className={s.cellTitle}>{row.title}{row.high_risk ? <Badge tone="bad">High risk</Badge> : null}<span className={s.cellSub}>{row.category}</span></td>
                  <td>{row.owner_name ?? "—"}</td>
                  <td><Badge tone="warn">{row.status}</Badge></td>
                  {canEdit ? (
                    <td>
                      <BotForm workspace={workspace} action={closeOpenAction} className={s.rowActions}>
                        <input type="hidden" name="id" value={row.id} />
                        <input className={s.input} name="closure_note" placeholder="Closure note" maxLength={500} />
                        <ActionButton className={`${s.button} ${s.small}`}>Close</ActionButton>
                      </BotForm>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      ) : <Empty icon={<CheckCircle2 size={28} aria-hidden />} title="No open actions">Tracked follow-ups from the Testing group appear here.</Empty>}
    </Card>
  );
}

async function SummaryTab({ workspace, companyId, groupIds, lookup, settings }: { workspace: ReportBotWorkspace; companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings }) {
  const date = localClock(new Date(), settings.timezone).date;
  if (workspace === "last_mile") {
    const db = reportBotDb();
    const [requests, reviews, actions] = groupIds.length ? await Promise.all([
      db.from("report_bot_requests").select("group_id,status").eq("company_id", companyId).eq("business_date", date).in("group_id", groupIds),
      db.from("report_bot_review_items").select("group_id").eq("company_id", companyId).in("group_id", groupIds).eq("review_status", "draft_ready"),
      db.from("report_bot_actions").select("group_id").eq("company_id", companyId).in("group_id", groupIds).in("status", ["open", "pending_evidence", "unmatched_closure"])
    ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
    const error = requests.error || reviews.error || actions.error;
    if (error) return <Card title="Daily summary"><p role="alert">Summary unavailable. Please retry.</p></Card>;
    return <Card title={`Last Mile report summary · ${date}`} description="Today's scheduled reports and all outstanding follow-ups.">
      {groupIds.length ? <ReportTable className={s.table}>
        <thead><tr><th>Group / station</th><th>Expected</th><th>Received</th><th>Pending</th><th>Overdue</th><th>Review</th><th>Open actions</th></tr></thead>
        <tbody>{groupIds.map(id => {
          const rows = (requests.data ?? []).filter(r => r.group_id === id && r.status !== "cancelled");
          return <tr key={id}><td>{lookup.groupName.get(id)}</td><td>{rows.length}</td><td>{rows.filter(r => r.status === "received").length}</td><td>{rows.filter(r => r.status === "pending").length}</td><td>{rows.filter(r => r.status === "overdue" || r.status === "missed").length}</td><td>{(reviews.data ?? []).filter(r => r.group_id === id).length}</td><td>{(actions.data ?? []).filter(r => r.group_id === id).length}</td></tr>;
        })}</tbody>
      </ReportTable> : <p className={s.hint}>Add your Last Mile groups and report schedules to start tracking.</p>}
    </Card>;
  }
  const result = groupIds.length
    ? await reportBotDb().from("report_bot_daily_summaries").select("*").eq("company_id", companyId).eq("business_date", date).in("group_id", groupIds)
    : { data: [] };
  const rows = (result.data ?? []) as Array<{ group_id: string; summary: Record<string, unknown>; updated_at: string }>;
  return (
    <Card title={`Daily site summary · ${date}`} icon={<FileText size={18} aria-hidden />} description="Portal rollup for loads, shortages, PPI/O2A exceptions, manpower, FEFO, temperature/infrastructure and unresolved actions. Not posted to WhatsApp until Live is explicitly enabled for that.">
      {rows.length ? rows.map((row) => {
        const summary = row.summary ?? {};
        return (
          <div key={row.group_id} className={s.item} style={{ marginBottom: 12 }}>
            <div className={s.itemTitle}>{lookup.groupName.get(row.group_id) ?? "Group"}</div>
            <div className={s.kpis}>
              <div className={s.kpi}><span>Loads</span><strong>{Number(summary.loads_received ?? 0)}</strong></div>
              <div className={s.kpi}><span>Shortage/damage/totes</span><strong>{Number(summary.shortages_damage_totes ?? 0)}</strong></div>
              <div className={s.kpi}><span>PPI/O2A exceptions</span><strong>{Number(summary.ppi_o2a_exceptions ?? 0)}</strong></div>
              <div className={s.kpi}><span>Manpower</span><strong>{Number(summary.manpower_exceptions ?? 0)}</strong></div>
              <div className={s.kpi}><span>Expiry/FEFO</span><strong>{Number(summary.expiry_fefo ?? 0)}</strong></div>
              <div className={s.kpi}><span>Temp / infra</span><strong>{Number(summary.temperature_infrastructure ?? 0)}</strong></div>
            </div>
            <p className={s.hint}>Updated {when(row.updated_at, settings.timezone)}. Unresolved: {Array.isArray(summary.unresolved_actions) ? summary.unresolved_actions.length : 0}</p>
          </div>
        );
      }) : <Empty icon={<FileText size={28} aria-hidden />} title="No summary yet">Summaries refresh each cron minute for enabled groups once the TCC3 migration is applied.</Empty>}
    </Card>
  );
}

function ReportTypeForm({ workspace, report }: { workspace: ReportBotWorkspace; report?: ReportTypeRow }) {
  return (
    <BotForm workspace={workspace} action={saveReportType} className={s.formGrid}>
      {report ? <input type="hidden" name="id" value={report.id} /> : null}
      <Field label="Report name" hint="As the team calls it.">
        <input className={s.input} name="name" defaultValue={report?.name ?? ""} required maxLength={120} placeholder="EOD closure screenshot" />
      </Field>
      <Field label="What the photo looks like" hint="Helps the AI tell this report apart from other photos." className={s.span2}>
        <input className={s.input} name="description" defaultValue={report?.description ?? ""} maxLength={1000} placeholder="Screenshot of the station EOD dashboard with closure status" />
      </Field>
      <Field label="Rules to check" hint="One rule per line. Each is marked pass, fail or unclear, and failed rules are explained in the reply." className={s.span3}>
        <textarea className={s.textarea} name="rules" rows={5} defaultValue={report?.rules.join("\n") ?? ""} required placeholder={"Date on the screenshot is today\nPending liability shows zero\nStation code is visible"} />
      </Field>
      <div className={`${s.span3} ${s.formActions}`} style={{ justifyContent: "space-between" }}>
        <Toggle name="is_active" label="Active" hint="Paused report types stop all their reminders." defaultChecked={report?.is_active ?? true} />
        <ActionButton className={`${s.button} ${s.primary}`}>{report ? "Save changes" : "Add report type"}</ActionButton>
      </div>
    </BotForm>
  );
}

function ScheduleForm({ workspace, schedule, groups, reportTypes }: { workspace: ReportBotWorkspace; schedule?: ScheduleRow; groups: GroupRow[]; reportTypes: ReportTypeRow[] }) {
  return (
    <BotForm workspace={workspace} action={saveSchedule} className={s.formGrid}>
      {schedule ? <input type="hidden" name="id" value={schedule.id} /> : null}
      <Field label="Group">
        <select className={s.select} name="group_id" defaultValue={schedule?.group_id ?? ""} required>
          <option value="">Choose a group</option>
          {/* Only groups on the bot, plus a removed group this schedule still points at. */}
          {groups.filter((group) => group.is_enabled || group.id === schedule?.group_id).map((group) => <option key={group.id} value={group.id}>{group.group_name ?? "Unnamed group"}{group.is_enabled ? "" : " (removed from the bot)"}</option>)}
        </select>
      </Field>
      <Field label="Report">
        <select className={s.select} name="report_type_id" defaultValue={schedule?.report_type_id ?? ""} required>
          <option value="">Choose a report</option>
          {reportTypes.map((report) => <option key={report.id} value={report.id}>{report.name}{report.is_active ? "" : " (paused)"}</option>)}
        </select>
      </Field>
      <Field label="Due by" hint="24-hour time.">
        <input className={s.input} name="due_time" type="time" defaultValue={schedule?.due_time ?? "10:00"} required />
      </Field>
      <fieldset className={`${s.field} ${s.span3}`} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={s.label} style={{ marginBottom: 6 }}>Days</legend>
        <div className={s.days}>
          {DAY_NAMES.map((day, index) => (
            <label key={day} className={s.day}>
              <input type="checkbox" name="days" value={index} defaultChecked={schedule ? schedule.days_of_week.includes(index) : true} />
              <span>{day}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <ReminderTimesField defaultValue={schedule ? schedule.reminder_times.join(", ") : "09:00, 09:45"} />
      <div className={s.span3}>
        <Toggle
          name="stop_when_received"
          label="Stop reminders once the report arrives"
          hint="Turn off to post at every reminder time all day, even after the report is in (for groups asked at fixed intervals)."
          defaultChecked={schedule?.stop_when_received ?? true}
        />
      </div>
      <Field label="First reminder" className={s.span3}>
        <textarea className={s.textarea} name="first_reminder_template" rows={2} required defaultValue={schedule?.first_reminder_template ?? "Good morning {group} team. Please share today's *{report}* by {due_time}."} />
      </Field>
      <Field label="Follow-up reminder" hint="Used for the second reminder onwards." className={s.span3}>
        <textarea className={s.textarea} name="followup_template" rows={2} required defaultValue={schedule?.followup_template ?? "Reminder: *{report}* for {date} is still pending. Please share it here."} />
      </Field>
      <Field label="Overdue message (optional)" hint="Sent once at the due time if the report hasn't arrived." className={s.span3}>
        <textarea className={s.textarea} name="overdue_template" rows={2} defaultValue={schedule?.overdue_template ?? ""} placeholder="*{report}* for {date} is overdue." />
      </Field>
      <div className={`${s.span3} ${s.chips}`} aria-label="Placeholders you can use">
        {["{group}", "{report}", "{due_time}", "{date}"].map((chip) => <code key={chip} className={s.chip}>{chip}</code>)}
        <span className={s.hint}>WhatsApp formatting such as *bold* works.</span>
      </div>
      <div className={`${s.span3} ${s.formActions}`} style={{ justifyContent: "space-between" }}>
        <Toggle name="is_active" label="Active" defaultChecked={schedule?.is_active ?? true} />
        <ActionButton className={`${s.button} ${s.primary}`}>{schedule ? "Save changes" : "Add schedule"}</ActionButton>
      </div>
    </BotForm>
  );
}

function ReportsTab({ workspace, groups, reportTypes, schedules, lookup, canEdit }: { workspace: ReportBotWorkspace; groups: GroupRow[]; reportTypes: ReportTypeRow[]; schedules: ScheduleRow[]; lookup: Lookup; canEdit: boolean }) {
  const testingGroup = groups.find((group) => group.is_enabled && /^testing$/i.test((group.group_name ?? "").trim()));
  return (
    <div className={s.twoCol}>
      <Card title="Report types" icon={<FileText size={18} aria-hidden />} description="Separate report rules and checklists for this workspace.">
        {canEdit && workspace === "dark_store" ? (
          <div className={s.formActions} style={{ marginBottom: 12 }}>
            <BotForm workspace={workspace} action={installTcc3Templates}>
              <ActionButton className={`${s.button} ${s.primary}`}>Install TCC3 War Room templates</ActionButton>
            </BotForm>
            {testingGroup ? (
              <BotForm workspace={workspace} action={seedDraftSchedulesForGroup}>
                <input type="hidden" name="group_id" value={testingGroup.id} />
                <ActionButton className={s.button} confirm="Seed TCC3 schedules on Testing, activate timed reminders, and set the group to Review so replies can post?">Seed &amp; activate Testing reminders</ActionButton>
              </BotForm>
            ) : <span className={s.hint}>Enable a WhatsApp group named exactly “Testing” to seed reminders.</span>}
          </div>
        ) : null}
        {canEdit && workspace === "last_mile" ? (
          <div className={s.formActions} style={{ marginBottom: 12 }}>
            <BotForm workspace={workspace} action={installLastMileTemplates}>
              <ActionButton className={`${s.button} ${s.primary}`}>Install Station board templates</ActionButton>
            </BotForm>
            {testingGroup ? (
              <BotForm workspace={workspace} action={seedLastMileSchedulesForGroup}>
                <input type="hidden" name="group_id" value={testingGroup.id} />
                <ActionButton className={s.button} confirm="Seed Last Mile schedules on Testing (hourly 09:00–21:00 for board reports, evening EOD reminders), activate them, and set the group to Review?">Seed &amp; activate Testing reminders</ActionButton>
              </BotForm>
            ) : <span className={s.hint}>Enable a WhatsApp group named exactly “Testing” to seed hourly 09:00–21:00 reminders.</span>}
          </div>
        ) : null}
        <div className={s.itemList}>
          {reportTypes.map((report) => (
            <details key={report.id} className={s.item}>
              <summary>
                <div>
                  <div className={s.itemTitle}>{report.name}</div>
                  <div className={s.itemSub}>
                    {report.rules.length} rules
                    {report.slug ? <Badge tone="neutral">{report.slug}</Badge> : null}
                    {report.auto_reply_policy === "never" ? <Badge tone="warn">Review only</Badge> : null}
                    {report.is_active ? null : <Badge tone="neutral">Paused</Badge>}
                  </div>
                </div>
                <ChevronRight size={18} className={s.chevron} aria-hidden />
              </summary>
              <div className={s.itemBody}>
                {canEdit ? <ReportTypeForm workspace={workspace} report={report} /> : <ul className={s.checks}>{report.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}
              </div>
            </details>
          ))}
          {!reportTypes.length ? <Empty icon={<FileText size={28} aria-hidden />} title="No report types yet">{workspace === "dark_store" ? "Install TCC3 templates or add one manually." : "Install Station board templates or add one manually."}</Empty> : null}
          {canEdit ? (
            <details className={`${s.item} ${s.addItem}`} open={!reportTypes.length}>
              <summary><span>+ Add report type</span><ChevronRight size={18} className={s.chevron} aria-hidden /></summary>
              <div className={s.itemBody}><ReportTypeForm workspace={workspace} /></div>
            </details>
          ) : null}
        </div>
      </Card>
      <Card title="Schedules" icon={<CalendarCheck size={18} aria-hidden />} description="When each group must post each report, and when the bot reminds them. Times use the time zone in Settings. Reminders stop for the day as soon as that day's report photo arrives; use Send test reminder to try one any time.">
        <div className={s.itemList}>
          {schedules.map((schedule) => (
            <details key={schedule.id} className={s.item}>
              <summary>
                <div>
                  <div className={s.itemTitle}>{lookup.groupName.get(schedule.group_id) ?? "Group"} · {lookup.reportName.get(schedule.report_type_id) ?? "Report"}</div>
                  <div className={s.itemSub}>
                    Due {formatClock(schedule.due_time)}
                    {DAY_NAMES.map((day, index) => <span key={day} className={`${s.dayChip} ${schedule.days_of_week.includes(index) ? s.dayOn : ""}`}>{day.slice(0, 2)}</span>)}
                    {schedule.is_active ? null : <Badge tone="neutral">Paused</Badge>}
                  </div>
                  <div className={s.itemSub}>
                    {schedule.reminder_times.length > 8
                      ? `${schedule.reminder_times.length} reminders, ${formatClock(schedule.reminder_times[0])} to ${formatClock(schedule.reminder_times[schedule.reminder_times.length - 1])}`
                      : `Reminders: ${schedule.reminder_times.map(formatClock).join(", ") || "none"}`}
                    {schedule.stop_when_received === false ? <Badge tone="info">Every time, even after the report</Badge> : null}
                  </div>
                </div>
                <ChevronRight size={18} className={s.chevron} aria-hidden />
              </summary>
              {canEdit ? (
                <div className={s.itemBody}>
                  <div className={s.formActions} style={{ justifyContent: "flex-start", marginBottom: 14, flexWrap: "wrap" }}>
                    <BotForm workspace={workspace} action={previewScheduleReminders}>
                      <input type="hidden" name="id" value={schedule.id} />
                      <ActionButton className={`${s.button} ${s.small} ${s.ghost}`}>Preview today&apos;s slots</ActionButton>
                    </BotForm>
                    <BotForm workspace={workspace} action={sendTestReminder} className={s.formActions}>
                      <input type="hidden" name="id" value={schedule.id} />
                      <ActionButton className={`${s.button} ${s.small}`}><Send size={14} aria-hidden />Send test reminder</ActionButton>
                    </BotForm>
                    <span className={s.hint}>
                      {schedule.is_active ? "Active" : "Draft/inactive"}
                      {schedule.schedule_kind ? ` · ${schedule.schedule_kind}` : ""}
                      . Test send needs company Live + group Review/Live (Testing only during pilot).
                    </span>
                  </div>
                  <ScheduleForm workspace={workspace} schedule={schedule} groups={groups} reportTypes={reportTypes} />
                </div>
              ) : null}
            </details>
          ))}
          {!schedules.length ? <Empty icon={<CalendarCheck size={28} aria-hidden />} title="No schedules yet">A schedule ties a report to a group and sets its reminder times.</Empty> : null}
          {canEdit ? (
            groups.length && reportTypes.length ? (
              <details className={`${s.item} ${s.addItem}`} open={!schedules.length}>
                <summary><span>+ Add schedule</span><ChevronRight size={18} className={s.chevron} aria-hidden /></summary>
                <div className={s.itemBody}><ScheduleForm workspace={workspace} groups={groups} reportTypes={reportTypes} /></div>
              </details>
            ) : <p className={s.hint}>Add a group (Groups tab) and a report type first.</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
