import "server-only";
import { AI_TIMEOUT_MS, AiError, analyseReportImage, type CandidateReport } from "@/lib/report-bot/ai";
import { fetchReportImage } from "@/lib/report-bot/image";
import { pruneInboundEvents, refreshDailySummary } from "@/lib/report-bot/events";
import {
  canAutoSendToGroup,
  canSendToGroup,
  composeFeedback,
  decideGroupDelivery,
  displayDate,
  dueReminderSteps,
  formatClock,
  localClock,
  mentionFor,
  parseClockTime,
  randomDelaySeconds,
  renderTemplate,
  retryDelayMinutes,
  reviewStatusFor,
  senderLabel,
  sniffImageType,
  type GroupMode,
  type LocalClock
} from "@/lib/report-bot/logic";
import { reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";

type GroupRow = { id: string; company_id: string; wa_group_id: string; group_name: string | null; location_id: string | null; is_enabled: boolean; bot_in_group: boolean; mode?: GroupMode };
type ScheduleRow = {
  id: string; company_id: string; group_id: string; report_type_id: string; days_of_week: number[]; reminder_times: string[];
  due_time: string; first_reminder_template: string; followup_template: string; overdue_template: string | null; is_active: boolean;
  stop_when_received: boolean;
};
type RequestRow = {
  id: string; company_id: string; schedule_id: string; group_id: string; report_type_id: string; business_date: string; status: string;
  reminders_handled: number; reminders_sent: number; overdue_notified: boolean; last_reminder_minute: number | null;
};
type SubmissionRow = {
  id: string; company_id: string; group_id: string; request_id: string | null; report_type_id: string | null; wa_message_id: string;
  sender_jid: string | null; sender_name: string | null; caption: string | null; message_at: string; media_ref: string | null;
  media_mime: string | null; wa_message_record: string | null; attempts: number;
};
type OutboxRow = {
  id: string; company_id: string; group_id: string; kind: string; body: string; quoted_message_id: string | null; quoted_participant: string | null;
  mentions: string[]; submission_id: string | null; request_id: string | null; attempts: number; stale_after: string | null;
};

const MAX_SUBMISSION_ATTEMPTS = 4;
const MAX_OUTBOX_ATTEMPTS = 5;

function nowIso(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function must<T>(result: { data: T | null; error: { message: string } | null }, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data as T;
}

async function loadGroups(companyId: string) {
  const db = reportBotDb();
  return must(await db.from("report_bot_groups").select("id,company_id,wa_group_id,group_name,location_id,is_enabled,bot_in_group,mode").eq("company_id", companyId), "Load groups") as GroupRow[];
}

/** Creates today's request rows; idempotent on (schedule, date). Also closes past days. */
export async function syncDailyRequests(settings: ReportBotSettings, clock: LocalClock) {
  const db = reportBotDb();
  const companyId = settings.company_id;
  const [schedules, groups] = await Promise.all([
    db.from("report_bot_schedules").select("*, report:report_bot_report_types(is_active)").eq("company_id", companyId).eq("is_active", true),
    loadGroups(companyId)
  ]);
  const enabledGroups = new Set(groups.filter((group) => group.is_enabled).map((group) => group.id));
  const rows = (must(schedules, "Load schedules") as Array<ScheduleRow & { report: { is_active: boolean } | null }>)
    .filter((schedule) => schedule.report?.is_active && enabledGroups.has(schedule.group_id) && (schedule.days_of_week ?? []).includes(clock.weekday))
    .map((schedule) => ({
      company_id: companyId,
      schedule_id: schedule.id,
      group_id: schedule.group_id,
      report_type_id: schedule.report_type_id,
      business_date: clock.date
    }));
  if (rows.length) {
    must(await db.from("report_bot_requests").upsert(rows, { onConflict: "schedule_id,business_date", ignoreDuplicates: true }), "Create daily requests");
  }
  must(await db.from("report_bot_requests")
    .update({ status: "missed", updated_at: nowIso() })
    .eq("company_id", companyId)
    .lt("business_date", clock.date)
    .in("status", ["pending", "overdue"]), "Close past requests");
  return rows.length;
}

/** Queues due reminders and overdue notices for open requests (live mode only). */
export async function queueReminders(settings: ReportBotSettings, clock: LocalClock) {
  const db = reportBotDb();
  const companyId = settings.company_id;
  const requests = must(await db.from("report_bot_requests")
    .select("*, schedule:report_bot_schedules(*), report:report_bot_report_types(name,is_active), group:report_bot_groups(id,group_name,is_enabled,wa_group_id,mode)")
    .eq("company_id", companyId)
    .eq("business_date", clock.date)
    .in("status", ["pending", "overdue", "received"]), "Load open requests") as Array<RequestRow & {
      schedule: ScheduleRow | null; report: { name: string; is_active: boolean } | null; group: { id: string; group_name: string | null; is_enabled: boolean; mode?: GroupMode } | null;
    }>;
  let queued = 0;
  for (const request of requests) {
    const schedule = request.schedule;
    if (!schedule || !schedule.is_active || !request.report?.is_active || !request.group?.is_enabled) continue;
    // Observe groups never receive reminders; Review/Live (and Testing pilot) may when company is live.
    if (!canSendToGroup(settings.mode, request.group.mode ?? "observe", request.group.group_name)) continue;
    if ((schedule as ScheduleRow & { schedule_kind?: string }).schedule_kind === "event_driven") continue;
    // A received report ends the day's reminders unless the schedule asks at every interval.
    const received = request.status === "received";
    if (received && schedule.stop_when_received !== false) continue;
    const values = {
      group: request.group.group_name ?? "team",
      report: request.report?.name ?? "report",
      due_time: formatClock(schedule.due_time),
      date: displayDate(request.business_date)
    };
    const steps = dueReminderSteps(schedule.reminder_times ?? [], request.last_reminder_minute, clock.minutes, settings.max_reminder_delay_minutes);
    let sent = request.reminders_sent;
    for (const step of steps) {
      if (step.action !== "send") continue;
      // The follow-up says the report is still pending, which is wrong once it has arrived.
      const template = sent === 0 || received ? schedule.first_reminder_template : schedule.followup_template;
      const body = renderTemplate(template, values);
      if (!body) continue;
      const inserted = await db.from("report_bot_outbox").upsert({
        company_id: companyId,
        group_id: request.group_id,
        kind: sent === 0 ? "reminder" : "followup",
        // Keyed by the slot's time, so an edited reminder list can't repeat or skip a slot.
        dedupe_key: `reminder:${request.id}:${step.minute}`,
        body,
        request_id: request.id,
        stale_after: nowIso(settings.max_reminder_delay_minutes * 60)
      }, { onConflict: "company_id,dedupe_key", ignoreDuplicates: true });
      if (inserted.error) throw new Error(`Queue reminder: ${inserted.error.message}`);
      sent += 1;
      queued += 1;
    }
    const dueMinutes = parseClockTime(schedule.due_time) ?? 24 * 60;
    const becameOverdue = request.status === "pending" && clock.minutes >= dueMinutes;
    const overdueBody = schedule.overdue_template ? renderTemplate(schedule.overdue_template, values) : "";
    const sendOverdue = becameOverdue && !request.overdue_notified && overdueBody && clock.minutes - dueMinutes <= settings.max_reminder_delay_minutes;
    if (sendOverdue) {
      const inserted = await db.from("report_bot_outbox").upsert({
        company_id: companyId,
        group_id: request.group_id,
        kind: "overdue",
        dedupe_key: `overdue:${request.id}`,
        body: overdueBody,
        request_id: request.id,
        stale_after: nowIso(settings.max_reminder_delay_minutes * 60)
      }, { onConflict: "company_id,dedupe_key", ignoreDuplicates: true });
      if (inserted.error) throw new Error(`Queue overdue notice: ${inserted.error.message}`);
      queued += 1;
    }
    const lastMinute = steps.length ? steps[steps.length - 1].minute : request.last_reminder_minute;
    if (lastMinute !== request.last_reminder_minute || sent !== request.reminders_sent || becameOverdue) {
      // Guard on the slot we read so a concurrent run can't double count.
      // Matching the status we read means a report that arrives meanwhile is never set back.
      const update = db.from("report_bot_requests").update({
        last_reminder_minute: lastMinute,
        reminders_handled: request.reminders_handled + steps.length,
        reminders_sent: sent,
        ...(becameOverdue ? { status: "overdue" } : {}),
        overdue_notified: request.overdue_notified || Boolean(sendOverdue) || becameOverdue,
        updated_at: nowIso()
      }).eq("id", request.id).eq("status", request.status);
      must(await (request.last_reminder_minute === null ? update.is("last_reminder_minute", null) : update.eq("last_reminder_minute", request.last_reminder_minute)), "Update request");
    }
  }
  return queued;
}

/** Overdue status still matters in listen mode for the Today board, without sending anything. */
export async function markOverdue(settings: ReportBotSettings, clock: LocalClock) {
  const db = reportBotDb();
  const requests = must(await db.from("report_bot_requests")
    .select("id, schedule:report_bot_schedules(due_time)")
    .eq("company_id", settings.company_id)
    .eq("business_date", clock.date)
    .eq("status", "pending"), "Load pending requests") as unknown as Array<{ id: string; schedule: { due_time: string } | null }>;
  const overdue = requests.filter((request) => clock.minutes >= (parseClockTime(request.schedule?.due_time ?? "") ?? 24 * 60)).map((request) => request.id);
  if (overdue.length) {
    must(await db.from("report_bot_requests").update({ status: "overdue", updated_at: nowIso() }).in("id", overdue).eq("status", "pending"), "Mark overdue");
  }
}

async function candidatesForSubmission(settings: ReportBotSettings, submission: SubmissionRow, businessDate: string) {
  const db = reportBotDb();
  // "missed" is included: an image posted before midnight but analysed after the
  // day rolled over still counts for the day it was posted.
  const requests = must(await db.from("report_bot_requests")
    .select("id,status,report_type_id,business_date, report:report_bot_report_types(id,name,description,rules,is_active)")
    .eq("group_id", submission.group_id)
    .eq("business_date", businessDate)
    .in("status", ["pending", "overdue", "received", "missed"]), "Load open requests for image") as unknown as Array<{
      id: string; status: string; report_type_id: string; business_date: string;
      report: { id: string; name: string; description: string | null; rules: string[]; is_active: boolean } | null;
    }>;
  const open = requests.filter((request) => request.report?.is_active);
  // Prefer requests still waiting; a later image for a received request is a resubmission.
  open.sort((a, b) => Number(a.status === "received") - Number(b.status === "received"));
  if (open.length) {
    return {
      requests: open,
      candidates: [...new Map(open.map((request) => [request.report!.id, {
        id: request.report!.id, name: request.report!.name, description: request.report!.description, rules: request.report!.rules ?? []
      }])).values()] as CandidateReport[]
    };
  }
  if (!settings.accept_without_request) return { requests: [], candidates: [] as CandidateReport[] };
  const schedules = must(await db.from("report_bot_schedules")
    .select("report:report_bot_report_types(id,name,description,rules,is_active)")
    .eq("group_id", submission.group_id)
    .eq("is_active", true), "Load group report types") as unknown as Array<{ report: CandidateReport & { is_active: boolean } | null }>;
  return {
    requests: [],
    candidates: schedules.flatMap((row) => (row.report?.is_active ? [{ id: row.report.id, name: row.report.name, description: row.report.description, rules: row.report.rules ?? [] }] : []))
  };
}

/** Returns true when the failure means later items would fail the same way this run. */
async function settleSubmissionFailure(submission: SubmissionRow, error: unknown) {
  const db = reportBotDb();
  const message = error instanceof Error ? error.message : "Unknown error";
  const blocked = (error instanceof AiError || error instanceof WorkerError) && error.blocked;
  const workerDown = error instanceof WorkerError && error.unavailable;
  const retryable = error instanceof AiError || error instanceof WorkerError ? error.retryable : true;
  const finalAttempt = submission.attempts >= MAX_SUBMISSION_ATTEMPTS;
  const status = blocked ? "blocked" : workerDown || (retryable && !finalAttempt) ? "queued" : "failed";
  // Blocked rows wait for a settings fix and an unreachable worker is not the image's
  // fault; neither should use up the image's attempts.
  const giveBack = blocked || workerDown;
  must(await db.from("report_bot_submissions").update({
    status,
    status_reason: message.slice(0, 500),
    attempts: giveBack ? Math.max(submission.attempts - 1, 0) : submission.attempts,
    next_attempt_at: nowIso((workerDown ? 2 : retryDelayMinutes(submission.attempts)) * 60),
    locked_until: null,
    updated_at: nowIso()
  }).eq("id", submission.id), "Record submission failure");
  return giveBack;
}

export async function processSubmissions(settings: ReportBotSettings, deadline: number) {
  const db = reportBotDb();
  let processed = 0;
  // Only start an image when a full AI call (plus download and save) still fits in this run.
  while (Date.now() < deadline - AI_TIMEOUT_MS - 30_000) {
    const claimed = must(await db.rpc("report_bot_claim_submissions", { p_company_id: settings.company_id, p_limit: 1, p_lease_seconds: 240 }), "Claim submissions") as SubmissionRow[];
    const submission = claimed[0];
    if (!submission) break;
    processed += 1;
    try {
      const group = must(await db.from("report_bot_groups").select("id,group_name,location_id,is_enabled,mode, station:stations(station_code,station_name)").eq("id", submission.group_id).single(), "Load group") as unknown as GroupRow & { station: { station_code: string; station_name: string | null } | null; mode?: GroupMode };
      if (!group.is_enabled) {
        must(await db.from("report_bot_submissions").update({ status: "skipped", status_reason: "Group was disabled before the image was analysed.", locked_until: null, updated_at: nowIso() }).eq("id", submission.id), "Skip submission");
        continue;
      }
      // Unified inbound path may already have classified this image.
      if ((submission as SubmissionRow & { review_id?: string | null }).review_id) {
        must(await db.from("report_bot_submissions").update({ locked_until: null, updated_at: nowIso() }).eq("id", submission.id), "Release analysed submission");
        continue;
      }
      // Judge the image against the day it was posted, not the day it is analysed.
      const businessDate = localClock(new Date(submission.message_at), settings.timezone).date;
      const { requests, candidates } = await candidatesForSubmission(settings, submission, businessDate);
      if (!candidates.length) {
        must(await db.from("report_bot_submissions").update({ status: "skipped", status_reason: "No report was scheduled for this group that day.", locked_until: null, updated_at: nowIso() }).eq("id", submission.id), "Skip submission");
        continue;
      }
      const image = await fetchReportImage(settings, submission.media_ref, submission.wa_message_record);
      const mime = sniffImageType(image);
      if (!mime) throw new AiError("The stored image could not be read.", false);
      const input = {
        image,
        mime,
        candidates,
        groupName: group.group_name ?? "group",
        stationLabel: group.station ? [group.station.station_code, group.station.station_name].filter(Boolean).join(" · ") : null,
        businessDate,
        caption: submission.caption
      };
      let analysis;
      try {
        analysis = await analyseReportImage(settings, input);
      } catch (error) {
        // One quick retry for a transient failure (malformed reply, a 5xx), instead of making
        // the sender wait for the next run. Quota limits won't clear in seconds, so skip those.
        const transient = error instanceof AiError && error.retryable && !error.blocked && !/quota/i.test(error.message);
        if (!transient || Date.now() > deadline - AI_TIMEOUT_MS - 40_000) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        analysis = await analyseReportImage(settings, input);
      }
      const reportType = candidates.find((candidate) => candidate.id === analysis.matched_report_type_id) ?? null;
      const request = reportType ? requests.find((row) => row.report_type_id === reportType.id) ?? null : null;
      const groupMode = group.mode ?? "observe";
      const decision = decideGroupDelivery(analysis, settings, {
        companyMode: settings.mode,
        groupMode,
        highRiskActions: analysis.open_actions.some((action) => action.high_risk)
      });
      const feedback = decision === "silent" ? null : composeFeedback(settings, {
        verdict: analysis.verdict,
        feedback: analysis.feedback,
        report: reportType?.name ?? "Report",
        // Tag the sender (@mention) so WhatsApp shows their name and notifies them.
        sender: mentionFor(submission.sender_jid)?.text ?? senderLabel(submission.sender_name, submission.sender_jid),
        group: group.group_name ?? "",
        date: displayDate(businessDate),
        checks: analysis.checks
      });
      const autoOk = decision === "auto_send" && canAutoSendToGroup(settings.mode, groupMode);
      const status = decision === "silent" ? "ignored" : autoOk ? "queued_to_send" : "awaiting_approval";
      must(await db.from("report_bot_submissions").update({
        status,
        status_reason: decision === "silent" ? "Not a report image." : null,
        request_id: request?.id ?? null,
        report_type_id: reportType?.id ?? null,
        ai_provider: settings.ai_provider,
        ai_model: settings.ai_model,
        ai_result: analysis,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        feedback_text: feedback,
        locked_until: null,
        updated_at: nowIso()
      }).eq("id", submission.id), "Save analysis");
      // Best-effort review row for the legacy image path (inbound table may already have one).
      const reviewStatus = reviewStatusFor(groupMode, decision, Boolean(feedback?.trim()));
      const reviewInsert = await db.from("report_bot_review_items").insert({
        company_id: settings.company_id,
        group_id: submission.group_id,
        submission_id: submission.id,
        report_type_id: reportType?.id ?? null,
        request_id: request?.id ?? null,
        review_status: reviewStatus,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        reason: analysis.extracted_summary,
        extracted_facts: analysis.extracted_fields,
        open_actions: analysis.open_actions,
        feedback_draft: feedback,
        ai_result: analysis,
        ai_provider: settings.ai_provider,
        ai_model: settings.ai_model,
        updated_at: nowIso()
      });
      if (reviewInsert.error && !/does not exist|schema cache/i.test(reviewInsert.error.message)) {
        throw new Error(`Save review item: ${reviewInsert.error.message}`);
      }
      if (request && analysis.is_report) {
        // A resubmission updates the verdict but keeps the first time the report arrived.
        must(await db.from("report_bot_requests").update({
          status: "received",
          ...(request.status === "received" ? {} : { received_at: submission.message_at }),
          last_verdict: analysis.verdict,
          updated_at: nowIso()
        }).eq("id", request.id).in("status", ["pending", "overdue", "received", "missed"]), "Mark request received");
      }
      if (autoOk && feedback) await queueFeedback(settings, submission, feedback, null);
    } catch (error) {
      if (await settleSubmissionFailure(submission, error)) break;
    }
  }
  return processed;
}

/** Feedback older than this is no longer useful in a busy group chat. */
const FEEDBACK_STALE_HOURS = 12;

/**
 * `immediate`: a person just approved it, so there is no reason to wait. Automatic
 * replies get the short configured delay so they don't land the same second.
 */
export async function queueFeedback(
  settings: ReportBotSettings,
  submission: Pick<SubmissionRow, "id" | "company_id" | "group_id" | "wa_message_id" | "sender_jid">,
  body: string,
  userId: string | null,
  options: { immediate?: boolean } = {}
) {
  const delay = options.immediate ? 0 : randomDelaySeconds(settings.reply_delay_min_seconds, settings.reply_delay_max_seconds);
  // Only mention the sender if the reply still contains their @tag (a reviewer may have edited it out).
  const mention = mentionFor(submission.sender_jid);
  const result = await reportBotDb().from("report_bot_outbox").upsert({
    company_id: submission.company_id,
    group_id: submission.group_id,
    kind: "feedback",
    dedupe_key: `feedback:${submission.id}`,
    body,
    quoted_message_id: submission.wa_message_id,
    quoted_participant: submission.sender_jid,
    mentions: mention && body.includes(mention.text) ? [mention.jid] : [],
    submission_id: submission.id,
    not_before: nowIso(delay),
    stale_after: nowIso(delay + FEEDBACK_STALE_HOURS * 3600),
    created_by: userId
  }, { onConflict: "company_id,dedupe_key", ignoreDuplicates: true });
  if (result.error) throw new Error(`Queue feedback: ${result.error.message}`);
}

/** How long the sender waits for a message about to fall due (reply delay, group gap). */
const SHORT_WAIT_MS = 15_000;

/** Sends due outbox items through the worker, one group message at a time. */
export async function flushOutbox(settings: ReportBotSettings, deadline: number) {
  const db = reportBotDb();
  let sent = 0;
  while (Date.now() < deadline - 20_000) {
    const claimed = must(await db.rpc("report_bot_claim_outbox", { p_company_id: settings.company_id, p_limit: 1, p_lease_seconds: 60 }), "Claim outbox") as OutboxRow[];
    const item = claimed[0];
    if (!item) {
      // A reply due in a few seconds is sent now rather than on next minute's run.
      const next = await db.from("report_bot_outbox").select("not_before").eq("company_id", settings.company_id).eq("status", "pending")
        .order("not_before", { ascending: true }).limit(1).maybeSingle();
      const waitMs = next.data ? new Date(next.data.not_before).getTime() - Date.now() + 250 : Infinity;
      if (waitMs > 0 && waitMs <= SHORT_WAIT_MS && Date.now() + waitMs < deadline - 20_000) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      break;
    }
    const release = (fields: Record<string, unknown>) => db.from("report_bot_outbox").update({ ...fields, locked_until: null, updated_at: nowIso() }).eq("id", item.id);
    if (item.stale_after && new Date(item.stale_after).getTime() < Date.now()) {
      await release({ status: "cancelled", status_reason: "Too late to send; skipped so the group does not get a stale reminder." });
      continue;
    }
    if (item.request_id && item.kind !== "feedback") {
      const request = await db.from("report_bot_requests").select("status, schedule:report_bot_schedules(stop_when_received)").eq("id", item.request_id).maybeSingle();
      const row = request.data as { status: string; schedule: { stop_when_received: boolean } | null } | null;
      // Interval schedules keep asking after the report arrives; skipped or missed days never do.
      const keepAsking = row?.status === "received" && row.schedule?.stop_when_received === false;
      if (row && !["pending", "overdue"].includes(row.status) && !keepAsking) {
        await release({ status: "cancelled", status_reason: row.status === "received" ? "Today's report had already arrived, so reminders stopped." : `Not sent: today's report is ${row.status}.` });
        continue;
      }
      // An image from this group is still being analysed: it may be the report, so
      // hold the reminder briefly rather than nag right after someone posted it.
      // Only a fresh photo on its first attempt counts: one stuck retrying must never
      // hold reminders until they go stale and get cancelled.
      const analysing = await db.from("report_bot_submissions").select("id", { head: true, count: "exact" })
        .eq("group_id", item.group_id).eq("status", "queued").lte("attempts", 1).gte("message_at", nowIso(-10 * 60));
      if (analysing.count) {
        await release({ not_before: nowIso(30), attempts: Math.max(item.attempts - 1, 0) });
        continue;
      }
    }
    const group = must(await db.from("report_bot_groups").select("wa_group_id,group_name,is_enabled,bot_in_group,mode").eq("id", item.group_id).single(), "Load group") as Pick<GroupRow, "wa_group_id" | "group_name" | "is_enabled" | "bot_in_group" | "mode">;
    if (!group.is_enabled) {
      await release({ status: "cancelled", status_reason: "Group is disabled." });
      continue;
    }
    if (!canSendToGroup(settings.mode, group.mode ?? "observe", group.group_name)) {
      await release({ status: "cancelled", status_reason: "Group is in Observe mode (or the company bot is not Live)." });
      continue;
    }
    const lastSent = await db.from("report_bot_outbox").select("sent_at").eq("group_id", item.group_id).eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle();
    const gapEndsAt = lastSent.data?.sent_at ? new Date(lastSent.data.sent_at).getTime() + settings.group_min_gap_seconds * 1000 : 0;
    if (gapEndsAt > Date.now()) {
      // Keep the attempt count honest: waiting for the gap is not a failed attempt.
      await release({ not_before: new Date(gapEndsAt + 1000).toISOString(), attempts: Math.max(item.attempts - 1, 0) });
      continue;
    }
    try {
      const result = await workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        timeoutMs: 30000,
        body: {
          client_ref: item.id,
          to: group.wa_group_id,
          text: item.body,
          quoted: item.quoted_message_id ? { id: item.quoted_message_id, participant: item.quoted_participant } : null,
          mentions: item.mentions ?? []
        }
      });
      await release({ status: "sent", sent_at: nowIso(), sent_wa_message_id: result?.id ?? null, status_reason: null });
      if (item.submission_id) {
        await db.from("report_bot_submissions").update({ status: "sent", sent_at: nowIso(), updated_at: nowIso() }).eq("id", item.submission_id);
        await db.from("report_bot_review_items").update({ review_status: "sent", sent_at: nowIso(), updated_at: nowIso() })
          .eq("submission_id", item.submission_id).in("review_status", ["approved", "draft_ready"]);
      }
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Send failed";
      // Worker down or misconfigured: hold everything and keep attempts for when it is back.
      if (error instanceof WorkerError && (error.unavailable || error.blocked)) {
        await release({ status_reason: message.slice(0, 500), attempts: Math.max(item.attempts - 1, 0), not_before: nowIso(60) });
        break;
      }
      const retryable = error instanceof WorkerError ? error.retryable : true;
      const final = !retryable || item.attempts >= MAX_OUTBOX_ATTEMPTS;
      await release({
        status: final ? "failed" : "pending",
        status_reason: message.slice(0, 500),
        not_before: nowIso(retryDelayMinutes(item.attempts) * 60)
      });
      if (final && item.submission_id) {
        await db.from("report_bot_submissions").update({ status: "failed", status_reason: `Feedback not sent: ${message}`.slice(0, 500), updated_at: nowIso() }).eq("id", item.submission_id);
      }
      if (/not a member|not in this group/i.test(message)) await db.from("report_bot_groups").update({ bot_in_group: false, updated_at: nowIso() }).eq("id", item.group_id);
      // Worker down: stop this run instead of burning every item's attempts.
      if (retryable) break;
    }
  }
  return sent;
}

/**
 * Check new photos right away (called when the worker reports one) and post any reply
 * that's ready, instead of waiting for the minute cron. Safe alongside the cron: work is
 * claimed row by row.
 */
export async function processNow(settings: ReportBotSettings, deadline: number) {
  if (settings.mode === "off") return;
  await processSubmissions(settings, deadline);
  if (settings.mode === "live") await flushOutbox(settings, deadline);
}

/**
 * One minute's work. Each stage runs on its own: a failure in one (say, reminders hitting
 * a missing database column) is recorded but never stops sending or photo checks.
 */
export async function runReportBotCycle(settings: ReportBotSettings, deadline: number) {
  const clock = localClock(new Date(), settings.timezone);
  const summary = { company_id: settings.company_id, mode: settings.mode, requests: 0, reminders: 0, analysed: 0, sent: 0, errors: [] as string[] };
  if (settings.mode === "off") return summary;
  const stage = async <T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const message = `${name}: ${error instanceof Error ? error.message : "failed"}`;
      console.error("[report-bot]", message, { companyId: settings.company_id });
      summary.errors.push(message);
      return fallback;
    }
  };
  summary.requests = await stage("daily requests", () => syncDailyRequests(settings, clock), 0);
  if (settings.mode === "live") summary.reminders = await stage("reminders", () => queueReminders(settings, clock), 0);
  else await stage("overdue", () => markOverdue(settings, clock), undefined);
  // Send what's already due before the (slow) AI checks, so replies never wait behind them.
  if (settings.mode === "live") summary.sent = await stage("sending", () => flushOutbox(settings, Math.min(deadline, Date.now() + 60_000)), 0);
  summary.analysed = await stage("photo checks", () => processSubmissions(settings, deadline), 0);
  if (settings.mode === "live") summary.sent += await stage("sending", () => flushOutbox(settings, deadline), 0);
  await stage("retention", () => pruneInboundEvents(settings), 0);
  await stage("daily summaries", async () => {
    const clock = localClock(new Date(), settings.timezone);
    const groups = (await loadGroups(settings.company_id)).filter((group) => group.is_enabled);
    for (const group of groups) await refreshDailySummary(settings, group.id, clock.date);
    return groups.length;
  }, 0);
  return summary;
}
