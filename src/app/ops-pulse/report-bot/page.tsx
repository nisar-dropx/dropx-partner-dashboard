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
import { GroupPicker } from "@/components/report-bot-group-picker";
import { ReportThumb, ViewImageButton } from "@/components/report-bot-image-viewer";
import { hasPermission, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { formatClock, localClock, type AnalysisCheck, type ExtractedField } from "@/lib/report-bot/logic";
import { aiKeyConfigured, aiKeyName, aiProviderLabel, loadReportBotSettings, reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import {
  approveFeedback,
  reanalyseSubmission,
  rejectFeedback,
  removeGroup,
  saveGroupSelection,
  saveReportType,
  saveSchedule,
  sendAllWaiting,
  setAutoReply,
  setRequestStatus,
  updateGroup
} from "./actions";
import s from "./report-bot.module.css";
import { Badge, Card, Empty, Field, FlashMessage, loadSetupSteps, ReportBotNav, SETUP_HREF, StatusBadge, Toggle, VERDICT, when, sender, workerIsOnline, type Tone } from "./ui";

export const dynamic = "force-dynamic";
// "Approve and send" posts straight away inside the action, which needs more than the default time.
export const maxDuration = 60;

const TABS = [
  { key: "today", label: "Today", icon: CalendarCheck },
  { key: "review", label: "Review", icon: Inbox },
  { key: "groups", label: "Groups", icon: Users },
  { key: "reports", label: "Reports & schedules", icon: FileText }
] as const;
type Tab = (typeof TABS)[number]["key"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type GroupRow = {
  id: string; wa_group_id: string; group_name: string | null; participant_count: number | null; location_id: string | null;
  is_enabled: boolean; bot_in_group: boolean;
};
type ReportTypeRow = { id: string; name: string; description: string | null; rules: string[]; is_active: boolean };
type ScheduleRow = {
  id: string; group_id: string; report_type_id: string; days_of_week: number[]; reminder_times: string[]; due_time: string;
  first_reminder_template: string; followup_template: string; overdue_template: string | null; is_active: boolean;
};
type SubmissionRow = {
  id: string; group_id: string; sender_name: string | null; sender_jid: string | null; caption: string | null; message_at: string;
  status: string; status_reason: string | null; verdict: string | null; confidence: number | null; feedback_text: string | null;
  media_ref: string | null; report_type_id: string | null;
  ai_result: { checks?: AnalysisCheck[]; extracted_summary?: string; extracted_fields?: ExtractedField[] } | null;
};
type Lookup = { groupName: Map<string, string>; reportName: Map<string, string> };

function tabHref(tab: Tab) {
  return `/report-bot?tab=${tab}`;
}

export default async function ReportBotPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, REPORT_BOT_PAGE, "edit");
  // Old links to the moved tabs land on the setup page instead of a blank tab.
  const requested = searchParams?.tab;
  if (requested === "connection" || requested === "settings") redirect(SETUP_HREF);
  if (requested === "chats") redirect("/report-bot/chats");
  const tab: Tab = TABS.find((entry) => entry.key === requested)?.key ?? "today";
  const db = reportBotDb();

  let settings: ReportBotSettings;
  try {
    settings = await loadReportBotSettings(companyId);
  } catch (error) {
    return (
      <AppShell active="Report Bot" pageCode={REPORT_BOT_PAGE}>
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
    db.from("report_bot_groups").select("*").eq("company_id", companyId).order("group_name"),
    db.from("report_bot_report_types").select("*").eq("company_id", companyId).order("name"),
    loadSetupSteps(settings)
  ]);
  const groups = ((groupsResult.data ?? []) as GroupRow[]).filter((group) => canSeeGroup(authorization, group));
  const groupIds = groups.map((group) => group.id);
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
    <AppShell active="Report Bot" pageCode={REPORT_BOT_PAGE}>
      <div className={s.page}>
        <header className={s.hero}>
          <div>
            <span className={s.eyebrow}><Bot size={13} aria-hidden /> Ops Pulse · Dark Store</span>
            <h1>Report Bot</h1>
            <p>Reminds WhatsApp groups to share their daily reports, then checks each report photo and replies with feedback.</p>
          </div>
          <div className={s.formActions}>
            <Badge tone={modeTone} className={s.modeBadge}>{modeLabel}</Badge>
            <Link className={s.button} href={SETUP_HREF}><Settings2 size={15} aria-hidden />Setup</Link>
          </div>
        </header>

        <div className={s.tiles}>
          <Link className={s.tile} href={`${SETUP_HREF}#mode`}>
            <span className={`${s.tileIcon} ${settings.mode === "live" ? s.good : settings.mode === "listen" ? s.warn : ""}`}><Bot size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>Mode</span><div className={s.tileValue}>{modeLabel}</div><div className={s.tileHint}>{settings.mode === "live" ? "Sends reminders and replies" : settings.mode === "listen" ? "Checks photos, sends nothing" : "Not listening to groups"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#whatsapp`}>
            <span className={`${s.tileIcon} ${s[linked ? "good" : "bad"]}`}><Smartphone size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>WhatsApp</span><div className={s.tileValue}>{linked ? "Connected" : "Not linked"}</div><div className={s.tileHint}>{settings.connected_number ? `+${settings.connected_number}` : "Link a number to start"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#worker`}>
            <span className={`${s.tileIcon} ${s[workerOnline ? "good" : settings.last_worker_seen_at ? "warn" : "bad"]}`}><Server size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>Worker</span><div className={s.tileValue}>{workerOnline ? "Online" : settings.last_worker_seen_at ? "Not responding" : "Not started"}</div><div className={s.tileHint}>{settings.last_worker_seen_at ? `Last seen ${when(settings.last_worker_seen_at, settings.timezone)}` : "Start it from Setup"}</div></span>
          </Link>
          <Link className={s.tile} href={`${SETUP_HREF}#ai`}>
            <span className={`${s.tileIcon} ${s[aiReady ? "good" : "bad"]}`}><Sparkles size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>AI check</span><div className={s.tileValue}>{aiReady ? `${aiProviderLabel(settings.ai_provider)} ready` : "Key missing"}</div><div className={s.tileHint}>{aiReady ? settings.ai_model : `Add ${aiKeyName(settings.ai_provider)} in Vercel`}</div></span>
          </Link>
        </div>

        {doneSteps < steps.length ? (
          <div className={s.setupBanner}>
            <span><strong>Setup {doneSteps} of {steps.length} done.</strong> Finish it to start receiving report checks.</span>
            <Link className={`${s.button} ${s.primary} ${s.small}`} href={SETUP_HREF}>Finish setup<ChevronRight size={14} aria-hidden /></Link>
          </div>
        ) : null}

        <FlashMessage />

        <ReportBotNav active={tab} waiting={waitingCount.count ?? 0} attention={attentionCount.count ?? 0} />

        {tab === "today" ? await TodayTab({ companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "review" ? await ReviewTab({ companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "groups" ? await GroupsTab({ authorization, groups, canEdit }) : null}
        {tab === "reports" ? <ReportsTab groups={groups} reportTypes={reportTypes} schedules={schedules} lookup={lookup} canEdit={canEdit} /> : null}
      </div>
    </AppShell>
  );
}

async function TodayTab({ companyId, groupIds, lookup, settings, canEdit }: { companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings; canEdit: boolean }) {
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
            <table className={s.table}>
              <thead><tr><th>Group</th><th>Report</th><th>Due</th><th>Reminders</th><th>Status</th><th>Result</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
              <tbody>
                {rows.map((row) => {
                  const verdict = row.last_verdict ? VERDICT[row.last_verdict] : null;
                  return (
                    <tr key={row.id}>
                      <td className={s.cellTitle}>{lookup.groupName.get(row.group_id) ?? "—"}</td>
                      <td>{lookup.reportName.get(row.report_type_id) ?? "—"}</td>
                      <td>{row.schedule ? formatClock(row.schedule.due_time) : "—"}</td>
                      <td>{row.reminders_sent} of {row.schedule?.reminder_times?.length ?? 0}</td>
                      <td><StatusBadge value={row.status} />{row.received_at ? <span className={s.cellSub}>{when(row.received_at, settings.timezone)}</span> : null}</td>
                      <td>{verdict ? <Badge tone={verdict[1]}>{verdict[0]}</Badge> : "—"}</td>
                      {canEdit ? (
                        <td>
                          <div className={s.rowActions}>
                            {["pending", "overdue"].includes(row.status) ? (
                              <>
                                <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="received" /><ActionButton className={`${s.button} ${s.small}`}>Mark received</ActionButton></form>
                                <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="cancelled" /><ActionButton className={`${s.button} ${s.small} ${s.ghost}`} confirm="Cancel today's reminders for this group?">Skip today</ActionButton></form>
                              </>
                            ) : row.status === "cancelled" ? (
                              <form action={setRequestStatus}><input type="hidden" name="id" value={row.id} /><input type="hidden" name="status" value="pending" /><ActionButton className={`${s.button} ${s.small}`}>Reopen</ActionButton></form>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={<CalendarCheck size={28} aria-hidden />} title={settings.mode === "off" ? "The bot is off" : "Nothing due today"}>
            {settings.mode === "off" ? <>Turn on <Link href={`${SETUP_HREF}#mode`}>Listen only</Link> to start tracking reports.</> : <>Reports appear here on days that have a <Link href={tabHref("reports")}>schedule</Link>.</>}
          </Empty>
        )}
      </Card>
      <SubmissionTable rows={images} lookup={lookup} timeZone={settings.timezone} title="Photos in the last 24 hours" emptyText="No report photos have been posted in your groups in the last 24 hours." />
    </>
  );
}

function SubmissionTable({ rows, lookup, timeZone, title, emptyText }: { rows: SubmissionRow[]; lookup: Lookup; timeZone: string; title: string; emptyText: string }) {
  return (
    <Card title={title} icon={<Inbox size={18} aria-hidden />} flush action={<span className={`${s.count} ${s.countMuted}`}>{rows.length}</span>}>
      {rows.length ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
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
                    <td><StatusBadge value={row.status} />{row.status_reason ? <span className={s.cellSub}>{row.status_reason}</span> : null}</td>
                    <td>{verdict ? <Badge tone={verdict[1]}>{verdict[0]}</Badge> : "—"}</td>
                    <td>{row.media_ref ? <ViewImageButton submissionId={row.id} title={`Photo from ${sender(row)}`} className={`${s.button} ${s.small} ${s.ghost}`}>View</ViewImageButton> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

async function ReviewTab({ companyId, groupIds, lookup, settings, canEdit }: { companyId: string; groupIds: string[]; lookup: Lookup; settings: ReportBotSettings; canEdit: boolean }) {
  const db = reportBotDb();
  const [waiting, attention, recent] = groupIds.length ? await Promise.all([
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).eq("status", "awaiting_approval").order("message_at").limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["failed", "blocked"]).order("message_at", { ascending: false }).limit(50),
    db.from("report_bot_submissions").select("*").eq("company_id", companyId).in("group_id", groupIds).in("status", ["sent", "ignored", "rejected", "skipped", "queued_to_send"]).order("message_at", { ascending: false }).limit(30)
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const waitingRows = (waiting.data ?? []) as SubmissionRow[];
  const attentionRows = (attention.data ?? []) as SubmissionRow[];
  const auto = settings.approval_mode === "auto";
  return (
    <>
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
                <form action={sendAllWaiting}>
                  <ActionButton className={s.button} confirm={`Post the AI's reply for all ${waitingRows.length} waiting photos?`}><Send size={15} aria-hidden />Send all waiting</ActionButton>
                </form>
              ) : null}
              <form action={setAutoReply}>
                <input type="hidden" name="auto" value={auto ? "off" : "on"} />
                <ActionButton className={`${s.button} ${auto ? "" : s.primary}`}><Sparkles size={15} aria-hidden />{auto ? "Turn auto-reply off" : "Turn auto-reply on"}</ActionButton>
              </form>
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
                      <form action={approveFeedback} className={s.reply}>
                        <input type="hidden" name="id" value={row.id} />
                        <Field label="Reply to post in the group" hint="Edit freely. It's posted as a reply to this photo.">
                          <textarea className={s.textarea} name="feedback_text" rows={4} defaultValue={row.feedback_text ?? ""} required maxLength={3000} />
                        </Field>
                        <div className={s.replyActions}>
                          <ActionButton className={`${s.button} ${s.primary}`}><Send size={15} aria-hidden />Approve and send</ActionButton>
                          <ActionButton className={`${s.button} ${s.ghost}`} formAction={reanalyseSubmission} skipValidation><RefreshCw size={15} aria-hidden />Check again</ActionButton>
                          <ActionButton className={`${s.button} ${s.danger}`} formAction={rejectFeedback} skipValidation>Don&apos;t send</ActionButton>
                        </div>
                      </form>
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
            <table className={s.table}>
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
                        <form action={reanalyseSubmission} className={s.rowActions}>
                          <input type="hidden" name="id" value={row.id} />
                          <ActionButton className={`${s.button} ${s.small}`}><RefreshCw size={14} aria-hidden />Retry</ActionButton>
                          <ActionButton className={`${s.button} ${s.small} ${s.ghost}`} formAction={rejectFeedback}>Dismiss</ActionButton>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <SubmissionTable rows={(recent.data ?? []) as SubmissionRow[]} lookup={lookup} timeZone={settings.timezone} title="Recently handled" emptyText="Handled photos will be listed here." />
    </>
  );
}

async function GroupsTab({ authorization, groups, canEdit }: { authorization: AuthorizationContext; groups: GroupRow[]; canEdit: boolean }) {
  let stores: Array<{ id: string; station_code: string; station_name: string | null }> = [];
  let storeError: string | null = null;
  try {
    stores = (await darkStoreScope(authorization)).locations;
  } catch (error) {
    storeError = error instanceof Error ? error.message : "Stores could not be loaded.";
  }
  // Only groups ticked in the picker are on the bot and shown here.
  const active = groups.filter((group) => group.is_enabled);
  return (
    <Card
      title="WhatsApp groups"
      icon={<Users size={18} aria-hidden />}
      description="The report groups the bot listens to. Add or remove them from the list of groups the linked number is in; the bot ignores every other chat and never reads private messages."
      action={canEdit ? <GroupPicker action={saveGroupSelection} disabled={!authorization.hasAllLocationAccess} /> : null}
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
                    {group.bot_in_group ? <Badge tone="good">Listening</Badge> : <Badge tone="bad">Bot number not in group</Badge>}
                    <Link href={`/report-bot/chats?group=${group.id}`}>Open chat</Link>
                  </div>
                </div>
              </div>
              <form action={updateGroup} className={s.inlineForm}>
                <input type="hidden" name="group_id" value={group.id} />
                <Field label="Store">
                  <select className={s.select} name="location_id" defaultValue={group.location_id ?? ""} disabled={!canEdit}>
                    <option value="">{authorization.hasAllLocationAccess ? "No store linked" : "Choose a store"}</option>
                    {stores.map((store) => <option key={store.id} value={store.id}>{store.station_code}{store.station_name ? ` · ${store.station_name}` : ""}</option>)}
                  </select>
                </Field>
                {canEdit ? <ActionButton className={`${s.button} ${s.small}`}>Save</ActionButton> : null}
              </form>
              {canEdit ? (
                <form action={removeGroup}>
                  <input type="hidden" name="group_id" value={group.id} />
                  <ActionButton className={`${s.button} ${s.small} ${s.danger}`} confirm={`Remove "${group.group_name ?? "this group"}" from the bot? It stops listening and posting there; history is kept.`}>Remove</ActionButton>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Users size={28} aria-hidden />} title="No groups on the bot yet">
          {canEdit ? <>Press <strong>Add or remove groups</strong> and tick the report groups.</> : "An editor adds the report groups here."}
          {" "}The WhatsApp number must be <Link href={`${SETUP_HREF}#whatsapp`}>linked</Link> first.
        </Empty>
      )}
    </Card>
  );
}

function ReportTypeForm({ report }: { report?: ReportTypeRow }) {
  return (
    <form action={saveReportType} className={s.formGrid}>
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
    </form>
  );
}

function ScheduleForm({ schedule, groups, reportTypes }: { schedule?: ScheduleRow; groups: GroupRow[]; reportTypes: ReportTypeRow[] }) {
  return (
    <form action={saveSchedule} className={s.formGrid}>
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
      <Field label="Reminder times" hint="24-hour times, separated by commas (up to 6). Leave empty to track the report without reminding." className={s.span3}>
        <input className={s.input} name="reminder_times" defaultValue={schedule ? schedule.reminder_times.join(", ") : "09:00, 09:45"} placeholder="09:00, 09:45" />
      </Field>
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
    </form>
  );
}

function ReportsTab({ groups, reportTypes, schedules, lookup, canEdit }: { groups: GroupRow[]; reportTypes: ReportTypeRow[]; schedules: ScheduleRow[]; lookup: Lookup; canEdit: boolean }) {
  return (
    <div className={s.twoCol}>
      <Card title="Report types" icon={<FileText size={18} aria-hidden />} description="What each report photo must show.">
        <div className={s.itemList}>
          {reportTypes.map((report) => (
            <details key={report.id} className={s.item}>
              <summary>
                <div>
                  <div className={s.itemTitle}>{report.name}</div>
                  <div className={s.itemSub}>{report.rules.length} rules {report.is_active ? null : <Badge tone="neutral">Paused</Badge>}</div>
                </div>
                <ChevronRight size={18} className={s.chevron} aria-hidden />
              </summary>
              <div className={s.itemBody}>
                {canEdit ? <ReportTypeForm report={report} /> : <ul className={s.checks}>{report.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}
              </div>
            </details>
          ))}
          {!reportTypes.length ? <Empty icon={<FileText size={28} aria-hidden />} title="No report types yet">Add the first one, for example your EOD screenshot.</Empty> : null}
          {canEdit ? (
            <details className={`${s.item} ${s.addItem}`} open={!reportTypes.length}>
              <summary><span>+ Add report type</span><ChevronRight size={18} className={s.chevron} aria-hidden /></summary>
              <div className={s.itemBody}><ReportTypeForm /></div>
            </details>
          ) : null}
        </div>
      </Card>
      <Card title="Schedules" icon={<CalendarCheck size={18} aria-hidden />} description="When each group must post each report, and when the bot reminds them. Times use the time zone in Settings.">
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
                  <div className={s.itemSub}>Reminders: {schedule.reminder_times.map(formatClock).join(", ") || "none"}</div>
                </div>
                <ChevronRight size={18} className={s.chevron} aria-hidden />
              </summary>
              {canEdit ? <div className={s.itemBody}><ScheduleForm schedule={schedule} groups={groups} reportTypes={reportTypes} /></div> : null}
            </details>
          ))}
          {!schedules.length ? <Empty icon={<CalendarCheck size={28} aria-hidden />} title="No schedules yet">A schedule ties a report to a group and sets its reminder times.</Empty> : null}
          {canEdit ? (
            groups.length && reportTypes.length ? (
              <details className={`${s.item} ${s.addItem}`} open={!schedules.length}>
                <summary><span>+ Add schedule</span><ChevronRight size={18} className={s.chevron} aria-hidden /></summary>
                <div className={s.itemBody}><ScheduleForm groups={groups} reportTypes={reportTypes} /></div>
              </details>
            ) : <p className={s.hint}>Add a group (Groups tab) and a report type first.</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
