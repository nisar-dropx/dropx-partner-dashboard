import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  HelpCircle,
  Inbox,
  Info,
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
import { ActionButton, CopyButton, ReportThumb } from "@/components/report-bot-controls";
import { ReportBotConnection } from "@/components/report-bot-connection";
import { hasPermission, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { formatClock, localClock, type AnalysisCheck, type ExtractedField } from "@/lib/report-bot/logic";
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
import s from "./report-bot.module.css";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "today", label: "Today", icon: CalendarCheck },
  { key: "review", label: "Review", icon: Inbox },
  { key: "groups", label: "Groups", icon: Users },
  { key: "reports", label: "Reports & schedules", icon: FileText },
  { key: "connection", label: "Connection", icon: Smartphone },
  { key: "settings", label: "Settings", icon: Settings2 }
] as const;
type Tab = (typeof TABS)[number]["key"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORKER_FRESH_MS = 3 * 60 * 1000;

type Tone = "good" | "warn" | "bad" | "info" | "neutral";
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

const STATUS: Record<string, [string, Tone]> = {
  queued: ["Checking", "info"],
  blocked: ["On hold", "warn"],
  awaiting_approval: ["Waiting for review", "warn"],
  queued_to_send: ["Sending", "info"],
  sent: ["Reply sent", "good"],
  ignored: ["Not a report", "neutral"],
  skipped: ["Skipped", "neutral"],
  rejected: ["Not sent", "neutral"],
  failed: ["Failed", "bad"],
  pending: ["Waiting", "neutral"],
  overdue: ["Overdue", "bad"],
  received: ["Received", "good"],
  missed: ["Missed", "bad"],
  cancelled: ["Cancelled", "neutral"]
};
const VERDICT: Record<string, [string, Tone]> = {
  pass: ["Looks good", "good"],
  fail: ["Needs correction", "bad"],
  needs_review: ["Unclear", "warn"],
  not_report: ["Not a report", "neutral"]
};

function Badge({ tone, children, className = "" }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={`${s.badge} ${s[tone]} ${className}`}>{children}</span>;
}

function StatusBadge({ value }: { value: string }) {
  const [label, tone] = STATUS[value] ?? [value, "neutral" as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`${s.field} ${className}`}>
      <span className={s.label}>{label}</span>
      {children}
      {hint ? <span className={s.hint}>{hint}</span> : null}
    </label>
  );
}

function Toggle({ name, label, hint, defaultChecked, disabled, form }: { name: string; label: string; hint?: string; defaultChecked?: boolean; disabled?: boolean; form?: string }) {
  return (
    <label className={s.switch}>
      <input type="checkbox" role="switch" name={name} defaultChecked={defaultChecked} disabled={disabled} form={form} />
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
    </label>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className={s.empty}>{icon}<strong>{title}</strong>{children ? <span>{children}</span> : null}</div>;
}

function Card({ title, icon, description, action, children, flush }: { title: string; icon?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div><h2>{icon}{title}</h2>{description ? <p>{description}</p> : null}</div>
        {action}
      </div>
      {flush ? children : <div className={s.cardBody}>{children}</div>}
    </section>
  );
}

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
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function sender(row: { sender_name: string | null; sender_jid: string | null }) {
  return row.sender_name || (row.sender_jid ? `+${row.sender_jid.split("@")[0].split(":")[0]}` : "Unknown sender");
}

function tabHref(tab: Tab) {
  return `/report-bot?tab=${tab}`;
}

export default async function ReportBotPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, REPORT_BOT_PAGE, "edit");
  const tab: Tab = TABS.find((entry) => entry.key === searchParams?.tab)?.key ?? "today";
  const flash = readFlash();
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

  const [groupsResult, reportTypesResult] = await Promise.all([
    db.from("report_bot_groups").select("*").eq("company_id", companyId).order("group_name"),
    db.from("report_bot_report_types").select("*").eq("company_id", companyId).order("name")
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
  const workerSeenMs = settings.last_worker_seen_at ? Date.now() - new Date(settings.last_worker_seen_at).getTime() : Infinity;
  const workerOnline = workerSeenMs < WORKER_FRESH_MS;
  const linked = settings.connection_state === "open";
  const steps = [
    { done: Boolean(settings.worker_url && settings.worker_token_hash && workerOnline), text: "Run the worker and save its address", tab: "connection" as Tab },
    { done: linked, text: "Link a WhatsApp number", tab: "connection" as Tab },
    { done: groups.some((group) => group.is_enabled), text: "Turn on a report group", tab: "groups" as Tab },
    { done: schedules.some((schedule) => schedule.is_active), text: "Add a report type and a schedule", tab: "reports" as Tab },
    { done: aiReady, text: `Add ${aiKeyName(settings.ai_provider)} in Vercel`, tab: "settings" as Tab },
    { done: settings.mode !== "off", text: "Switch the bot to Listen only", tab: "settings" as Tab }
  ];
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
          <Badge tone={modeTone} className={s.modeBadge}>{modeLabel}</Badge>
        </header>

        <div className={s.tiles}>
          <Link className={s.tile} href={tabHref("settings")}>
            <span className={`${s.tileIcon} ${settings.mode === "live" ? s.good : settings.mode === "listen" ? s.warn : ""}`}><Bot size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>Mode</span><div className={s.tileValue}>{modeLabel}</div><div className={s.tileHint}>{settings.mode === "live" ? "Sends reminders and replies" : settings.mode === "listen" ? "Checks photos, sends nothing" : "Not listening to groups"}</div></span>
          </Link>
          <Link className={s.tile} href={tabHref("connection")}>
            <span className={`${s.tileIcon} ${s[linked ? "good" : "bad"]}`}><Smartphone size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>WhatsApp</span><div className={s.tileValue}>{linked ? "Connected" : "Not linked"}</div><div className={s.tileHint}>{settings.connected_number ? `+${settings.connected_number}` : "Link a number to start"}</div></span>
          </Link>
          <Link className={s.tile} href={tabHref("connection")}>
            <span className={`${s.tileIcon} ${s[workerOnline ? "good" : settings.last_worker_seen_at ? "warn" : "bad"]}`}><Server size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>Worker</span><div className={s.tileValue}>{workerOnline ? "Online" : settings.last_worker_seen_at ? "Not responding" : "Not set up"}</div><div className={s.tileHint}>{settings.last_worker_seen_at ? `Last seen ${when(settings.last_worker_seen_at, settings.timezone)}` : "Deploy it, then add its address"}</div></span>
          </Link>
          <Link className={s.tile} href={tabHref("settings")}>
            <span className={`${s.tileIcon} ${s[aiReady ? "good" : "bad"]}`}><Sparkles size={18} aria-hidden /></span>
            <span><span className={s.tileLabel}>AI check</span><div className={s.tileValue}>{aiReady ? `${aiProviderLabel(settings.ai_provider)} ready` : "Key missing"}</div><div className={s.tileHint}>{aiReady ? settings.ai_model : `Add ${aiKeyName(settings.ai_provider)} in Vercel`}</div></span>
          </Link>
        </div>

        {doneSteps < steps.length ? (
          <section className={s.setup} aria-labelledby="setup-title">
            <div className={s.setupHead}>
              <h2 id="setup-title">Finish setting up</h2>
              <span>{doneSteps} of {steps.length} done</span>
            </div>
            <div className={s.progress} aria-hidden><span style={{ width: `${(doneSteps / steps.length) * 100}%` }} /></div>
            <ol className={s.steps}>
              {steps.map((step) => (
                <li key={step.text} className={`${s.step} ${step.done ? s.done : ""}`}>
                  {step.done ? <CheckCircle2 size={18} className={s.stepIcon} aria-label="Done" /> : <Circle size={18} className={s.stepIcon} aria-label="To do" />}
                  <span className={s.stepText}>{step.text}</span>
                  {step.done ? null : <Link className={s.stepLink} href={tabHref(step.tab)}>Open<ChevronRight size={14} aria-hidden /></Link>}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {flash.error || flash.notice ? (
          <div className={`${s.flash} ${flash.error ? s.flashError : s.flashSuccess}`} role={flash.error ? "alert" : "status"}>
            {flash.error ? <AlertTriangle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
            <div>
              <strong>{flash.error ? "That didn't work" : "Done"}</strong>
              {flash.error ?? flash.notice}
              {flash.token ? (
                <div className={s.tokenBox}>
                  <code>{flash.token}</code>
                  <CopyButton value={flash.token} className={`${s.button} ${s.small}`} />
                  <span className={s.hint}>Shown only this once.</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <nav className={s.tabs} aria-label="Report Bot sections">
          {TABS.map(({ key, label, icon: Icon }) => (
            <Link key={key} href={tabHref(key)} className={`${s.tab} ${tab === key ? s.tabActive : ""}`} aria-current={tab === key ? "page" : undefined}>
              <Icon size={16} aria-hidden />{label}
              {key === "review" && (waitingCount.count ?? 0) > 0 ? <span className={s.count} aria-label={`${waitingCount.count} waiting`}>{waitingCount.count}</span> : null}
              {key === "review" && (attentionCount.count ?? 0) > 0 ? <span className={`${s.count} ${s.countMuted}`} aria-label={`${attentionCount.count} need attention`}>{attentionCount.count}</span> : null}
            </Link>
          ))}
        </nav>

        {tab === "today" ? await TodayTab({ companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "review" ? await ReviewTab({ companyId, groupIds, lookup, settings, canEdit }) : null}
        {tab === "groups" ? await GroupsTab({ authorization, groups, canEdit }) : null}
        {tab === "reports" ? <ReportsTab groups={groups} reportTypes={reportTypes} schedules={schedules} lookup={lookup} canEdit={canEdit} /> : null}
        {tab === "connection" ? <ConnectionTab settings={settings} canEdit={canEdit} workerOnline={workerOnline} /> : null}
        {tab === "settings" ? <SettingsTab settings={settings} canEdit={canEdit} /> : null}
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
            {settings.mode === "off" ? <>Turn on <Link href={tabHref("settings")}>Listen only</Link> to start tracking reports.</> : <>Reports appear here on days that have a <Link href={tabHref("reports")}>schedule</Link>.</>}
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
                    <td>{row.media_ref ? <a className={`${s.button} ${s.small} ${s.ghost}`} href={`/api/report-bot/image/${row.id}`} target="_blank" rel="noreferrer">View</a> : null}</td>
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
  return (
    <>
      <Card
        title="Waiting for review"
        icon={<Inbox size={18} aria-hidden />}
        description={settings.mode === "live"
          ? "Compare the AI's reading with the photo, adjust the reply if needed, and approve. It's posted as a reply to the photo after a short delay."
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
                  <ReportThumb src={`/api/report-bot/image/${row.id}`} alt={`Report photo from ${sender(row)}`} className={s.thumb} missingClassName={s.thumbMissing} />
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
  const enabled = groups.filter((group) => group.is_enabled).length;
  return (
    <Card
      title="WhatsApp groups"
      icon={<Users size={18} aria-hidden />}
      description="Groups the linked number belongs to. Turn on only the report groups: the bot ignores every other chat and never reads private messages."
      action={canEdit ? <form action={syncGroups}><ActionButton className={`${s.button} ${s.primary}`}><RefreshCw size={15} aria-hidden />Refresh from WhatsApp</ActionButton></form> : null}
      flush
    >
      {storeError ? <div className={s.cardBody}><p className={s.hint} role="alert">{storeError}</p></div> : null}
      {groups.length ? (
        <div className={s.groupList}>
          <div className={s.cardBody} style={{ paddingBottom: 0 }}><span className={s.hint}>{enabled} of {groups.length} groups turned on</span></div>
          {groups.map((group) => (
            <form key={group.id} action={updateGroup} className={s.groupRow}>
              <input type="hidden" name="group_id" value={group.id} />
              <div>
                <div className={s.groupName}>{group.group_name ?? "Unnamed group"}</div>
                <div className={s.groupMeta}>
                  {group.participant_count ? <span>{group.participant_count} members</span> : null}
                  {group.bot_in_group ? null : <Badge tone="bad">Bot number not in group</Badge>}
                  {group.is_enabled ? <Badge tone="good">Listening</Badge> : null}
                </div>
              </div>
              <Field label="Store">
                <select className={s.select} name="location_id" defaultValue={group.location_id ?? ""} disabled={!canEdit}>
                  <option value="">{authorization.hasAllLocationAccess ? "No store linked" : "Choose a store"}</option>
                  {stores.map((store) => <option key={store.id} value={store.id}>{store.station_code}{store.station_name ? ` · ${store.station_name}` : ""}</option>)}
                </select>
              </Field>
              <Toggle name="is_enabled" label="Listen" defaultChecked={group.is_enabled} disabled={!canEdit} />
              {canEdit ? <ActionButton className={`${s.button} ${s.small}`}>Save</ActionButton> : <span />}
            </form>
          ))}
        </div>
      ) : (
        <Empty icon={<Users size={28} aria-hidden />} title="No groups yet">
          <Link href={tabHref("connection")}>Link WhatsApp</Link> first, then press Refresh from WhatsApp.
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
          {groups.map((group) => <option key={group.id} value={group.id}>{group.group_name ?? "Unnamed group"}{group.is_enabled ? "" : " (not listening)"}</option>)}
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

function ConnectionTab({ settings, canEdit, workerOnline }: { settings: ReportBotSettings; canEdit: boolean; workerOnline: boolean }) {
  const workerReady = Boolean(settings.worker_url && settings.worker_token_hash);
  const linked = settings.connection_state === "open";
  return (
    <div className={s.connectSteps}>
      <Card
        title="Worker"
        icon={<span className={`${s.stepNumber} ${workerReady && workerOnline ? s.stepNumberDone : ""}`}>1</span>}
        description="The always-on service that keeps WhatsApp connected. Deploy it from workers/whatsapp-report-bot, then connect it here."
        action={workerOnline ? <Badge tone="good">Online</Badge> : <Badge tone={settings.last_worker_seen_at ? "warn" : "neutral"}>{settings.last_worker_seen_at ? "Not responding" : "Not connected"}</Badge>}
      >
        <div className={s.session}>
          <form action={saveWorkerUrl} className={s.inlineForm}>
            <Field label="Worker address" hint="The https address the worker is reachable at.">
              <input className={s.input} name="worker_url" defaultValue={settings.worker_url ?? ""} placeholder="https://wa-bot.dropxlogistics.com" required disabled={!canEdit} />
            </Field>
            {canEdit ? <ActionButton className={`${s.button} ${s.primary}`}>Save address</ActionButton> : null}
          </form>
          <div className={s.divider} />
          <div className={s.inlineForm} style={{ alignItems: "center" }}>
            <div className={s.field} style={{ flex: 1 }}>
              <span className={s.label}>Worker token</span>
              <span className={s.hint}>{settings.worker_token_hash ? `Created ${when(settings.worker_token_created_at, settings.timezone)}. For security it can't be shown again; replace it if it's lost.` : "Create a token, then set it as WORKER_TOKEN on the worker."}</span>
            </div>
            {canEdit ? (
              <form action={rotateWorkerToken}>
                <ActionButton className={`${s.button} ${settings.worker_token_hash ? "" : s.primary}`} confirm={settings.worker_token_hash ? "Replace the token? The worker stops working until you update WORKER_TOKEN on it." : undefined}>
                  {settings.worker_token_hash ? "Replace token" : "Create token"}
                </ActionButton>
              </form>
            ) : null}
          </div>
          <p className={s.note}><Info size={16} aria-hidden /><span>On the worker set <code>PORTAL_URL=https://ops.dropxlogistics.com</code> and <code>WORKER_TOKEN</code> to the token, then restart it. It shows as Online within a minute.</span></p>
        </div>
      </Card>

      <Card
        title="WhatsApp number"
        icon={<span className={`${s.stepNumber} ${linked ? s.stepNumberDone : ""}`}>2</span>}
        description="Link any WhatsApp account as a linked device, for example your own number while testing. To change numbers later, unlink and link the new one; groups, schedules and history are kept."
      >
        <div className={s.session}>
          {workerReady ? (
            canEdit ? <ReportBotConnection polling initial={{ state: settings.connection_state, number: settings.connected_number, name: settings.connected_name, error: settings.connection_error }} />
              : <div className={s.sessionState}><Badge tone={linked ? "good" : "neutral"}>{linked ? "Connected" : "Not linked"}</Badge>{settings.connected_number ? <strong>+{settings.connected_number}</strong> : null}</div>
          ) : <p className={s.hint}>Finish step 1 first.</p>}
          {canEdit && workerReady ? (
            <>
              <div className={s.divider} />
              <div className={s.inlineForm}>
                {linked ? null : <form action={connectWhatsApp}><input type="hidden" name="method" value="qr" /><ActionButton className={`${s.button} ${s.primary}`}>Link with QR code</ActionButton></form>}
                {linked ? null : (
                  <form action={connectWhatsApp} className={s.inlineForm}>
                    <input type="hidden" name="method" value="code" />
                    <Field label="Or link with a code" hint="Number with country code, digits only.">
                      <input className={s.input} name="phone" inputMode="numeric" autoComplete="tel" placeholder="919876543210" required pattern="[0-9]{10,15}" />
                    </Field>
                    <ActionButton className={s.button}>Get code</ActionButton>
                  </form>
                )}
                {linked || settings.connection_state === "closed" ? (
                  <form action={disconnectWhatsApp}>
                    <ActionButton className={`${s.button} ${s.danger}`} confirm="Unlink this WhatsApp number? The bot stops until a number is linked again.">Unlink / switch number</ActionButton>
                  </form>
                ) : null}
              </div>
            </>
          ) : null}
          <p className={s.note}><Info size={16} aria-hidden /><span>The bot reads photos only from groups you turn on under Groups, and never reads private chats. Your own photos are ignored unless &quot;Check my own photos&quot; is on in Settings.</span></p>
        </div>
      </Card>
    </div>
  );
}

function SettingsTab({ settings, canEdit }: { settings: ReportBotSettings; canEdit: boolean }) {
  const modes = [
    { value: "off", title: "Off", text: "Not listening to any group." },
    { value: "listen", title: "Listen only", text: "Checks report photos but never posts. Use this while testing." },
    { value: "live", title: "Live", text: "Posts reminders and approved replies in the groups." }
  ];
  return (
    <form action={saveBotSettings} className={s.card}>
      <fieldset disabled={!canEdit} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <div className={s.cardBody} style={{ display: "grid", gap: 22 }}>
          <div className={s.section}>
            <h2 className={s.sectionTitle}><Bot size={17} aria-hidden />Mode</h2>
            <p className={s.sectionText}>Start in Listen only. Switch to Live when the checks look right.</p>
            <div className={s.choices} role="radiogroup" aria-label="Mode">
              {modes.map((mode) => (
                <label key={mode.value} className={s.choice}>
                  <input type="radio" name="mode" value={mode.value} defaultChecked={settings.mode === mode.value} />
                  <strong>{mode.title}</strong>
                  <span>{mode.text}</span>
                </label>
              ))}
            </div>
          </div>

          <div className={s.section}>
            <h2 className={s.sectionTitle}><Sparkles size={17} aria-hidden />AI that reads the photos</h2>
            <p className={s.sectionText}>The key is a deployment secret: add {aiKeyName(settings.ai_provider)} in Vercel. It is never stored in the portal.</p>
            <div className={s.formGrid}>
              <Field label="Provider">
                <select className={s.select} name="ai_provider" defaultValue={settings.ai_provider}>
                  <option value="gemini">Google Gemini (free tier)</option>
                  <option value="anthropic">Anthropic Claude (paid)</option>
                  <option value="openai">OpenAI (paid)</option>
                </select>
              </Field>
              <Field label="Model" hint="Pick a suggestion or type a model name.">
                <input className={s.input} name="ai_model" defaultValue={settings.ai_model} required maxLength={100} list="report-bot-models" />
              </Field>
              <datalist id="report-bot-models">
                <option value="gemini-3.8-flash">Gemini · free · best quality</option>
                <option value="gemini-3.5-flash-lite">Gemini · free · faster, higher daily limit</option>
                <option value="claude-opus-5-5">Claude · paid</option>
              </datalist>
              <Field label="Thoroughness" hint="Higher is more careful but slower.">
                <select className={s.select} name="ai_effort" defaultValue={settings.ai_effort}>
                  <option value="low">Quick</option>
                  <option value="medium">Balanced</option>
                  <option value="high">Thorough</option>
                </select>
              </Field>
            </div>
            {settings.ai_provider === "gemini" ? (
              <p className={s.note} style={{ marginTop: 14 }}><Info size={16} aria-hidden /><span>Gemini&apos;s free tier has daily limits; photos over the limit are retried later. Google may use free-tier photos to improve its products, so choose a paid provider if report photos must stay private.</span></p>
            ) : null}
          </div>

          <div className={s.section}>
            <h2 className={s.sectionTitle}><Send size={17} aria-hidden />Replies and approval</h2>
            <p className={s.sectionText}>Keep &quot;Approve every reply&quot; until you trust the readings.</p>
            <div className={s.formGrid}>
              <Field label="Approval">
                <select className={s.select} name="approval_mode" defaultValue={settings.approval_mode}>
                  <option value="manual">Approve every reply</option>
                  <option value="auto">Send confident results automatically</option>
                </select>
              </Field>
              <Field label="Auto-send when at least" hint="0.85 means the AI is 85% sure. Unclear results always wait for review.">
                <input className={s.input} name="auto_send_min_confidence" type="number" step="0.01" min="0.5" max="1" defaultValue={settings.auto_send_min_confidence} required />
              </Field>
              <Field label="Gap between bot messages" hint="Seconds, per group.">
                <input className={s.input} name="group_min_gap_seconds" type="number" min="0" max="3600" defaultValue={settings.group_min_gap_seconds} required />
              </Field>
              <Field label="Reply delay from" hint="Seconds. A random delay in this range looks more natural.">
                <input className={s.input} name="reply_delay_min_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_min_seconds} required />
              </Field>
              <Field label="Reply delay to" hint="Seconds.">
                <input className={s.input} name="reply_delay_max_seconds" type="number" min="0" max="3600" defaultValue={settings.reply_delay_max_seconds} required />
              </Field>
              <Field label="Skip reminders late by more than" hint="Minutes. Stops a burst of old reminders after an outage.">
                <input className={s.input} name="max_reminder_delay_minutes" type="number" min="1" max="1440" defaultValue={settings.max_reminder_delay_minutes} required />
              </Field>
            </div>
          </div>

          <div className={s.section}>
            <h2 className={s.sectionTitle}><FileText size={17} aria-hidden />Reply format</h2>
            <p className={s.sectionText}>How the reply looks in the group.</p>
            <div className={s.formGrid}>
              <Field label="Layout" className={s.span3} hint={<span className={s.chips}>{["{report}", "{sender}", "{group}", "{date}", "{verdict_label}", "{feedback}"].map((chip) => <code key={chip} className={s.chip}>{chip}</code>)}</span>}>
                <textarea className={s.textarea} name="feedback_template" rows={3} defaultValue={settings.feedback_template} required maxLength={1000} />
              </Field>
              <Field label="When it passes"><input className={s.input} name="label_pass" defaultValue={settings.label_pass} required maxLength={80} /></Field>
              <Field label="When it fails"><input className={s.input} name="label_fail" defaultValue={settings.label_fail} required maxLength={80} /></Field>
              <Field label="When it's unclear"><input className={s.input} name="label_review" defaultValue={settings.label_review} required maxLength={80} /></Field>
              <Field label="Reply language" hint="The AI writes its feedback in this language."><input className={s.input} name="feedback_language" defaultValue={settings.feedback_language} required maxLength={40} /></Field>
              <Field label="Longest reply" hint="Characters."><input className={s.input} name="max_feedback_chars" type="number" min="100" max="3000" defaultValue={settings.max_feedback_chars} required /></Field>
              <Field label="Time zone" hint="Used for schedules and dates, e.g. Asia/Kolkata."><input className={s.input} name="timezone" defaultValue={settings.timezone} required /></Field>
            </div>
          </div>

          <div className={s.section}>
            <h2 className={s.sectionTitle}><Settings2 size={17} aria-hidden />Testing</h2>
            <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
              <Toggle name="include_own_messages" label="Check my own photos" hint="For testing with your own number. The bot's own replies are always ignored." defaultChecked={settings.include_own_messages} />
              <Toggle name="accept_without_request" label="Check photos on days with no report due" hint="Otherwise photos are only checked on days that have a schedule." defaultChecked={settings.accept_without_request} />
            </div>
          </div>
        </div>
        {canEdit ? (
          <div className={`${s.formActions} ${s.stickyActions}`}>
            <ActionButton className={`${s.button} ${s.primary}`}>Save settings</ActionButton>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}
