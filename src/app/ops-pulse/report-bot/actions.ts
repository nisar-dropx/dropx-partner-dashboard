"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { canSendToGroup, displayDate, formatClock, GROUP_MODES, isValidTimeZone, localClock, normalizeDays, normalizeTimeList, parseClockTime, previewReminderSlots, renderTemplate, type GroupMode } from "@/lib/report-bot/logic";
import { flushOutbox, queueFeedback } from "@/lib/report-bot/pipeline";
import {
  generateWorkerToken,
  hashWorkerToken,
  loadReportBotSettings,
  reportBotDb,
  type ReportBotSettings
} from "@/lib/report-bot/settings";
import { TCC3_REPORT_TEMPLATES } from "@/lib/report-bot/tcc3-templates";
import { workerRequest } from "@/lib/report-bot/worker-client";

const FLASH_COOKIE = "dropx_report_bot_flash";
const TABS = new Set(["today", "review", "groups", "reports", "connection", "settings", "actions", "summary"]);

type Flash = { error?: string; notice?: string; token?: string };

function finish(tab: string, flash: Flash): never {
  cookies().set(FLASH_COOKIE, JSON.stringify(flash), { httpOnly: true, maxAge: 60, path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  // Connection and settings live on the setup page (Settings → Report Bot setup).
  if (tab === "worker") redirect("/report-bot/setup#worker");
  if (tab === "connection") redirect("/report-bot/setup#whatsapp");
  if (tab === "settings") redirect("/report-bot/setup");
  redirect(`/report-bot?tab=${TABS.has(tab) ? tab : "today"}`);
}

function isRedirect(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" && String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

/** Runs a mutation with edit permission and turns any error into a visible message on the same tab. */
async function mutate(tab: string, work: (context: { authorization: AuthorizationContext; companyId: string }) => Promise<Flash>) {
  const authorization = await requirePagePermission(REPORT_BOT_PAGE, "edit");
  const companyId = requireCompanyId(authorization);
  let flash: Flash;
  try {
    flash = await work({ authorization, companyId });
  } catch (error) {
    if (isRedirect(error)) throw error;
    flash = { error: error instanceof Error ? error.message : "Something went wrong. Please try again." };
  }
  finish(tab, flash);
}

/** Form text, trimmed, with Windows line endings from text boxes normalised to \n. */
function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").replace(/\r\n?/g, "\n").trim();
}

function boundedInt(form: FormData, name: string, label: string, min: number, max: number) {
  const value = Number(field(form, name));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}

function requiredText(form: FormData, name: string, label: string, max: number) {
  const value = field(form, name);
  if (!value) throw new Error(`${label} is required.`);
  if (value.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return value;
}

function check<T>(result: { data: T | null; error: { message: string } | null }, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data as T;
}

/** Best effort: the worker also polls config every minute, so a failure here only delays it. */
async function pushWorkerConfig(settings: ReportBotSettings) {
  if (!settings.worker_url || !settings.worker_token) return;
  const groups = settings.mode === "off"
    ? []
    : (check(await reportBotDb().from("report_bot_groups").select("wa_group_id").eq("company_id", settings.company_id).eq("is_enabled", true), "Load groups") ?? [])
      .map((group: { wa_group_id: string }) => group.wa_group_id);
  try {
    await workerRequest(settings, "/config", {
      method: "POST",
      timeoutMs: 5000,
      body: { mode: settings.mode, groups, include_own_messages: settings.mode !== "off" && settings.include_own_messages }
    });
  } catch {
    // The worker picks the change up on its next config poll.
  }
}

async function scopedGroup(authorization: AuthorizationContext, companyId: string, groupId: string) {
  const group = check(await reportBotDb().from("report_bot_groups").select("id,location_id,is_enabled,wa_group_id,mode").eq("company_id", companyId).eq("id", groupId).maybeSingle(), "Load group");
  if (!group || !canSeeGroup(authorization, group)) throw new Error("This group is not available to you.");
  return group as { id: string; location_id: string | null; is_enabled: boolean; wa_group_id: string; mode: GroupMode };
}

export async function saveBotSettings(form: FormData) {
  await mutate("settings", async ({ authorization, companyId }) => {
    const mode = field(form, "mode");
    if (!["off", "listen", "live"].includes(mode)) throw new Error("Choose a valid mode.");
    const timezone = requiredText(form, "timezone", "Time zone", 64);
    if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" is not a valid time zone (example: Asia/Kolkata).`);
    const provider = field(form, "ai_provider");
    if (!["gemini", "anthropic", "openai"].includes(provider)) throw new Error("Choose an AI provider.");
    const model = requiredText(form, "ai_model", "AI model", 100);
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error("AI model may only contain letters, numbers, dot, dash, colon and underscore.");
    const effort = field(form, "ai_effort");
    if (!["low", "medium", "high"].includes(effort)) throw new Error("Choose an AI effort level.");
    const approval = field(form, "approval_mode");
    if (!["manual", "auto"].includes(approval)) throw new Error("Choose an approval mode.");
    const threshold = Number(field(form, "auto_send_min_confidence"));
    if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) throw new Error("Auto-send confidence must be between 0.5 and 1.");
    const delayMin = boundedInt(form, "reply_delay_min_seconds", "Minimum reply delay", 0, 3600);
    const delayMax = boundedInt(form, "reply_delay_max_seconds", "Maximum reply delay", 0, 3600);
    if (delayMax < delayMin) throw new Error("Maximum reply delay must be at least the minimum.");
    const feedbackTemplate = requiredText(form, "feedback_template", "Feedback message", 1000);
    if (!feedbackTemplate.includes("{feedback}")) throw new Error("The feedback message must include {feedback}.");
    const previous = await loadReportBotSettings(companyId);
    const update = {
      mode,
      timezone,
      ai_provider: provider,
      ai_model: model,
      ai_effort: effort,
      approval_mode: approval,
      auto_send_min_confidence: threshold,
      reply_delay_min_seconds: delayMin,
      reply_delay_max_seconds: delayMax,
      group_min_gap_seconds: boundedInt(form, "group_min_gap_seconds", "Gap between messages", 0, 3600),
      max_reminder_delay_minutes: boundedInt(form, "max_reminder_delay_minutes", "Late reminder limit", 1, 1440),
      include_own_messages: form.get("include_own_messages") === "on",
      accept_without_request: form.get("accept_without_request") === "on",
      feedback_language: requiredText(form, "feedback_language", "Feedback language", 40),
      feedback_template: feedbackTemplate,
      label_pass: requiredText(form, "label_pass", "Pass label", 80),
      label_fail: requiredText(form, "label_fail", "Fail label", 80),
      label_review: requiredText(form, "label_review", "Review label", 80),
      max_feedback_chars: boundedInt(form, "max_feedback_chars", "Feedback length limit", 100, 3000),
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    };
    if (mode === "live" && (!previous.worker_url || !previous.worker_token)) throw new Error("Start the worker (step 1 of Report Bot setup) before switching to Live.");
    check(await reportBotDb().from("report_bot_settings").update(update).eq("company_id", companyId), "Save settings");
    // A settings fix (key, model, worker) is the only thing blocked images wait for.
    check(await reportBotDb().from("report_bot_submissions").update({ status: "queued", next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("company_id", companyId).eq("status", "blocked"), "Release blocked images");
    if (previous.mode === "live" && mode !== "live") {
      // Leaving Live must not leave reminders that would fire on the next switch back.
      check(await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: "Bot left Live mode.", updated_at: new Date().toISOString() })
        .eq("company_id", companyId).eq("status", "pending").neq("kind", "feedback"), "Cancel queued reminders");
    }
    await pushWorkerConfig({ ...previous, ...update } as ReportBotSettings);
    return { notice: mode === "live" ? "Saved. The bot is Live: reminders and approved feedback will be sent." : mode === "listen" ? "Saved. Listen-only: images are analysed but nothing is sent." : "Saved. The bot is off." };
  });
}

export async function saveWorkerUrl(form: FormData) {
  await mutate("worker", async ({ companyId }) => {
    const raw = field(form, "worker_url").replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Enter the full worker address, for example https://wa-bot.dropxlogistics.com");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) throw new Error("The worker address must start with https://");
    check(await reportBotDb().from("report_bot_settings").update({ worker_url: url.toString().replace(/\/+$/, ""), updated_at: new Date().toISOString() }).eq("company_id", companyId), "Save worker address");
    return { notice: "Worker address saved." };
  });
}

export async function rotateWorkerToken() {
  await mutate("worker", async ({ companyId }) => {
    await loadReportBotSettings(companyId);
    const token = generateWorkerToken();
    check(await reportBotDb().from("report_bot_settings").update({
      worker_token: token,
      worker_token_hash: hashWorkerToken(token),
      worker_token_created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId), "Save token");
    return { notice: "New worker token created. Put it in the worker's WORKER_TOKEN setting and restart the worker; the old token stops working now.", token };
  });
}

export async function connectWhatsApp(form: FormData) {
  await mutate("connection", async ({ companyId }) => {
    const settings = await loadReportBotSettings(companyId);
    const method = field(form, "method") === "code" ? "code" : "qr";
    const phone = field(form, "phone").replace(/\D/g, "");
    if (method === "code" && (phone.length < 10 || phone.length > 15)) throw new Error("Enter the WhatsApp number with country code, digits only (example 919876543210).");
    await workerRequest(settings, "/session/connect", { method: "POST", body: { method, phone: method === "code" ? phone : null } });
    await pushWorkerConfig(settings);
    return { notice: method === "code" ? "Open WhatsApp → Linked devices → Link with phone number, and enter the code shown below." : "Scan the QR code below from WhatsApp → Linked devices → Link a device." };
  });
}

export async function disconnectWhatsApp() {
  await mutate("connection", async ({ companyId }) => {
    const settings = await loadReportBotSettings(companyId);
    await workerRequest(settings, "/session/logout", { method: "POST", body: {} });
    check(await reportBotDb().from("report_bot_settings").update({
      connection_state: "logged_out", connected_number: null, connected_name: null, connection_error: null, updated_at: new Date().toISOString()
    }).eq("company_id", companyId), "Save connection");
    return { notice: "WhatsApp unlinked. You can now link a different number. Groups and schedules are kept." };
  });
}

/**
 * Saves the groups ticked in the "Add or remove groups" dialog. Ticked groups are
 * listened to and listed on the page; groups that were on and are now unticked are
 * turned off (kept for their history) and their queued messages are cancelled.
 */
export async function saveGroupSelection(form: FormData) {
  await mutate("groups", async ({ authorization, companyId }) => {
    // New groups have no store yet, so only people who see every store may add them.
    if (!authorization.hasAllLocationAccess) throw new Error("Only users with access to all stores can add or remove groups.");
    let picked: Array<{ id?: unknown; subject?: unknown; size?: unknown }>;
    try {
      picked = JSON.parse(field(form, "selected") || "[]");
    } catch {
      throw new Error("The group selection could not be read. Please try again.");
    }
    if (!Array.isArray(picked) || picked.length > 200) throw new Error("Select at most 200 groups.");
    const selected = picked.filter((group) => typeof group.id === "string" && /^[0-9-]+@g\.us$/.test(group.id));
    const now = new Date().toISOString();
    const db = reportBotDb();
    if (selected.length) {
      check(await db.from("report_bot_groups").upsert(selected.map((group) => ({
        company_id: companyId,
        wa_group_id: group.id as string,
        group_name: String(group.subject ?? "").slice(0, 200) || null,
        participant_count: Number.isInteger(group.size) ? group.size as number : null,
        is_enabled: true,
        bot_in_group: true,
        // mode defaults to observe on insert; never reset an existing group's Observe/Review/Live here.
        last_synced_at: now,
        updated_at: now
      })), { onConflict: "company_id,wa_group_id" }), "Save groups");
    }
    const keep = new Set(selected.map((group) => group.id as string));
    const enabled = check(await db.from("report_bot_groups").select("id,wa_group_id").eq("company_id", companyId).eq("is_enabled", true), "Load groups") as Array<{ id: string; wa_group_id: string }>;
    const removed = enabled.filter((group) => !keep.has(group.wa_group_id)).map((group) => group.id);
    if (removed.length) {
      check(await db.from("report_bot_groups").update({ is_enabled: false, updated_at: now }).in("id", removed), "Turn off groups");
      check(await db.from("report_bot_outbox").update({ status: "cancelled", status_reason: "Group removed from the bot.", updated_at: now })
        .in("group_id", removed).eq("status", "pending"), "Cancel queued messages");
    }
    await pushWorkerConfig(await loadReportBotSettings(companyId));
    return { notice: `${selected.length} group${selected.length === 1 ? "" : "s"} on the bot.${removed.length ? ` ${removed.length} removed.` : ""} Link each one to its store below.` };
  });
}

export async function updateGroup(form: FormData) {
  await mutate("groups", async ({ authorization, companyId }) => {
    const group = await scopedGroup(authorization, companyId, field(form, "group_id"));
    const locationId = field(form, "location_id") || null;
    if (locationId && !authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) throw new Error("You do not have access to that store.");
    if (!locationId && !authorization.hasAllLocationAccess) throw new Error("Choose one of your stores for this group.");
    if (locationId) {
      const station = check(await reportBotDb().from("stations").select("id").eq("company_id", companyId).eq("id", locationId).maybeSingle(), "Check store");
      if (!station) throw new Error("That store does not exist.");
    }
    check(await reportBotDb().from("report_bot_groups").update({ location_id: locationId, updated_at: new Date().toISOString() }).eq("id", group.id), "Save group");
    return { notice: "Store saved for this group." };
  });
}

export async function removeGroup(form: FormData) {
  await mutate("groups", async ({ authorization, companyId }) => {
    const group = await scopedGroup(authorization, companyId, field(form, "group_id"));
    const now = new Date().toISOString();
    check(await reportBotDb().from("report_bot_groups").update({ is_enabled: false, updated_at: now }).eq("id", group.id), "Remove group");
    check(await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: "Group removed from the bot.", updated_at: now })
      .eq("group_id", group.id).eq("status", "pending"), "Cancel queued messages");
    await pushWorkerConfig(await loadReportBotSettings(companyId));
    return { notice: "Group removed. The bot no longer listens or posts there; its history is kept." };
  });
}

export async function saveReportType(form: FormData) {
  await mutate("reports", async ({ authorization, companyId }) => {
    const id = field(form, "id");
    const rules = field(form, "rules").split(/\r?\n/).map((rule) => rule.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
    if (!rules.length) throw new Error("Add at least one rule, one per line.");
    if (rules.length > 25) throw new Error("Use at most 25 rules.");
    if (rules.some((rule) => rule.length > 300)) throw new Error("Each rule must be at most 300 characters.");
    const row = {
      name: requiredText(form, "name", "Report name", 120),
      description: field(form, "description").slice(0, 1000) || null,
      rules,
      is_active: form.get("is_active") === "on",
      updated_at: new Date().toISOString()
    };
    if (id) {
      check(await reportBotDb().from("report_bot_report_types").update(row).eq("company_id", companyId).eq("id", id), "Save report type");
    } else {
      check(await reportBotDb().from("report_bot_report_types").insert({ ...row, company_id: companyId, created_by: authorization.userId }), "Create report type");
    }
    return { notice: id ? "Report type updated." : "Report type created. Now add a schedule for a group." };
  });
}

export async function saveSchedule(form: FormData) {
  await mutate("reports", async ({ authorization, companyId }) => {
    const id = field(form, "id");
    if (id) {
      // The schedule being edited must also belong to one of this person's groups, not only its new group.
      const existing = check(await reportBotDb().from("report_bot_schedules").select("group_id").eq("company_id", companyId).eq("id", id).maybeSingle(), "Load schedule") as { group_id: string } | null;
      if (!existing) throw new Error("Schedule not found.");
      await scopedGroup(authorization, companyId, existing.group_id);
    }
    const group = await scopedGroup(authorization, companyId, field(form, "group_id"));
    const reportTypeId = field(form, "report_type_id");
    const reportType = check(await reportBotDb().from("report_bot_report_types").select("id").eq("company_id", companyId).eq("id", reportTypeId).maybeSingle(), "Check report type");
    if (!reportType) throw new Error("Choose a report type.");
    const days = normalizeDays(form.getAll("days").map(String));
    if (!days.length) throw new Error("Choose at least one day.");
    const dueTime = field(form, "due_time");
    if (parseClockTime(dueTime) === null) throw new Error("Due time must be HH:MM (24-hour).");
    const reminderTimes = normalizeTimeList(field(form, "reminder_times"));
    const row = {
      group_id: group.id,
      report_type_id: reportTypeId,
      days_of_week: days,
      reminder_times: reminderTimes,
      due_time: dueTime,
      first_reminder_template: requiredText(form, "first_reminder_template", "First reminder", 1000),
      followup_template: requiredText(form, "followup_template", "Follow-up reminder", 1000),
      overdue_template: field(form, "overdue_template").slice(0, 1000) || null,
      is_active: form.get("is_active") === "on",
      stop_when_received: form.get("stop_when_received") === "on",
      updated_at: new Date().toISOString()
    };
    const result = id
      ? await reportBotDb().from("report_bot_schedules").update(row).eq("company_id", companyId).eq("id", id)
      : await reportBotDb().from("report_bot_schedules").insert({ ...row, company_id: companyId, created_by: authorization.userId });
    if (result.error?.code === "23505") throw new Error("This group already has a schedule for that report. Edit the existing one.");
    check(result, "Save schedule");
    return { notice: reminderTimes.length ? "Schedule saved." : "Schedule saved without reminder times: the bot will track the report but not remind." };
  });
}

async function scopedSubmission(authorization: AuthorizationContext, companyId: string, id: string) {
  const row = check(await reportBotDb().from("report_bot_submissions")
    .select("id,company_id,group_id,wa_message_id,sender_jid,status, group:report_bot_groups(location_id)")
    .eq("company_id", companyId).eq("id", id).maybeSingle(), "Load submission") as unknown as {
      id: string; company_id: string; group_id: string; wa_message_id: string; sender_jid: string | null; status: string; group: { location_id: string | null } | null;
    } | null;
  if (!row || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) throw new Error("This image is not available to you.");
  return row;
}

export async function approveFeedback(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const submission = await scopedSubmission(authorization, companyId, field(form, "id"));
    const feedback = requiredText(form, "feedback_text", "Feedback", 3000);
    const settings = await loadReportBotSettings(companyId);
    const group = await scopedGroup(authorization, companyId, submission.group_id);
    if (!canSendToGroup(settings.mode, group.mode ?? "observe")) {
      throw new Error("Company must be Live and this group must be Review or Live to send a reply.");
    }
    // Conditional on the status we expect, so two reviewers can't both send it.
    const updated = check(await reportBotDb().from("report_bot_submissions").update({
      status: "queued_to_send", feedback_text: feedback, reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", submission.id).in("status", ["awaiting_approval", "failed"]).select("id"), "Approve feedback") as Array<{ id: string }>;
    if (!updated.length) throw new Error("Someone already handled this image.");
    // A retry after a failed send needs a fresh outbox row; the old one is finished.
    await reportBotDb().from("report_bot_outbox").delete().eq("company_id", companyId).eq("dedupe_key", `feedback:${submission.id}`).in("status", ["failed", "cancelled"]);
    await queueFeedback(settings, submission, feedback, authorization.userId, { immediate: true });
    return { notice: await sendNow(settings, [submission.id]) };
  });
}

/**
 * A person approved it, so post it right now instead of waiting for the minute cron.
 * Returns what actually happened, so the page never claims "sent" for a queued reply.
 */
async function sendNow(settings: ReportBotSettings, submissionIds: string[]) {
  if (settings.mode !== "live") return "Approved. It will be posted once the bot is switched to Live (within 12 hours).";
  try {
    await flushOutbox(settings, Date.now() + 45_000);
  } catch {
    // The minute cron retries anything left queued.
  }
  const rows = check(await reportBotDb().from("report_bot_submissions").select("status").in("id", submissionIds), "Check sending") as Array<{ status: string }>;
  const sent = rows.filter((row) => row.status === "sent").length;
  if (sent === submissionIds.length) return sent === 1 ? "Reply posted in the group." : `${sent} replies posted in their groups.`;
  return `${sent} of ${submissionIds.length} posted now; the rest go out within a minute (the worker may be busy or reconnecting).`;
}

export async function sendAllWaiting() {
  await mutate("review", async ({ authorization, companyId }) => {
    const settings = await loadReportBotSettings(companyId);
    const waiting = check(await reportBotDb().from("report_bot_submissions")
      .select("id,company_id,group_id,wa_message_id,sender_jid,feedback_text, group:report_bot_groups(location_id)")
      .eq("company_id", companyId).eq("status", "awaiting_approval").order("message_at").limit(25), "Load waiting") as unknown as Array<{
        id: string; company_id: string; group_id: string; wa_message_id: string; sender_jid: string | null; feedback_text: string | null; group: { location_id: string | null } | null;
      }>;
    const sendable = waiting.filter((row) => row.feedback_text?.trim() && canSeeGroup(authorization, { location_id: row.group?.location_id ?? null }));
    if (!sendable.length) throw new Error("Nothing is waiting that has a reply ready.");
    const approved: string[] = [];
    for (const row of sendable) {
      const updated = check(await reportBotDb().from("report_bot_submissions").update({
        status: "queued_to_send", reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("id", row.id).eq("status", "awaiting_approval").select("id"), "Approve") as Array<{ id: string }>;
      if (!updated.length) continue;
      await queueFeedback(settings, row, row.feedback_text!, authorization.userId, { immediate: true });
      approved.push(row.id);
    }
    return { notice: approved.length ? await sendNow(settings, approved) : "Someone else already handled these." };
  });
}

/**
 * Posts a schedule's first reminder now, whatever today's status. Scheduled reminders stop
 * once the day's report has arrived, so this is the way to try the wording and the link.
 */
export async function sendTestReminder(form: FormData) {
  await mutate("reports", async ({ authorization, companyId }) => {
    const settings = await loadReportBotSettings(companyId);
    if (settings.mode !== "live") throw new Error("Switch the bot to Live in Report Bot setup to post messages.");
    const schedule = check(await reportBotDb().from("report_bot_schedules")
      .select("id,group_id,due_time,first_reminder_template, report:report_bot_report_types(name), group:report_bot_groups(group_name,is_enabled,mode)")
      .eq("company_id", companyId).eq("id", field(form, "id")).maybeSingle(), "Load schedule") as unknown as {
        id: string; group_id: string; due_time: string; first_reminder_template: string;
        report: { name: string } | null; group: { group_name: string | null; is_enabled: boolean; mode: GroupMode } | null;
      } | null;
    if (!schedule) throw new Error("Schedule not found.");
    await scopedGroup(authorization, companyId, schedule.group_id);
    if (!schedule.group?.is_enabled) throw new Error("This group is not on the bot. Add it on the Groups tab first.");
    if (!canSendToGroup(settings.mode, schedule.group.mode ?? "observe")) {
      throw new Error("This group is in Observe mode. Switch it to Review (or Live) before sending a test reminder.");
    }
    const today = localClock(new Date(), settings.timezone).date;
    const body = renderTemplate(schedule.first_reminder_template, {
      group: schedule.group.group_name ?? "team",
      report: schedule.report?.name ?? "report",
      due_time: formatClock(schedule.due_time),
      date: displayDate(today)
    });
    const now = new Date();
    const dedupe = `test:${schedule.id}:${now.getTime()}`;
    check(await reportBotDb().from("report_bot_outbox").insert({
      company_id: companyId,
      group_id: schedule.group_id,
      kind: "reminder",
      dedupe_key: dedupe,
      body,
      not_before: now.toISOString(),
      stale_after: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      created_by: authorization.userId
    }), "Queue test reminder");
    try {
      await flushOutbox(settings, Date.now() + 45_000);
    } catch {
      // Reported below from the row's status.
    }
    const row = check(await reportBotDb().from("report_bot_outbox").select("status,status_reason").eq("company_id", companyId).eq("dedupe_key", dedupe).single(), "Check test reminder") as { status: string; status_reason: string | null };
    if (row.status === "sent") return { notice: `Test reminder posted in ${schedule.group.group_name ?? "the group"}.` };
    if (row.status === "failed") throw new Error(`The test reminder could not be posted: ${row.status_reason ?? "unknown error"}`);
    return { notice: `Test reminder queued; it goes out within a minute.${row.status_reason ? ` (${row.status_reason})` : ""}` };
  });
}

/** The Review tab's auto-reply switch. Unclear or low-confidence photos still wait for a person. */
export async function setAutoReply(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const auto = field(form, "auto") === "on";
    check(await reportBotDb().from("report_bot_settings").update({
      approval_mode: auto ? "auto" : "manual", updated_by: authorization.userId, updated_at: new Date().toISOString()
    }).eq("company_id", companyId), "Save auto-reply");
    return { notice: auto
      ? "Auto-reply is on: confident results are posted without a click. Unclear photos still wait here."
      : "Auto-reply is off: every reply waits for approval here." };
  });
}

export async function rejectFeedback(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const submission = await scopedSubmission(authorization, companyId, field(form, "id"));
    const updated = check(await reportBotDb().from("report_bot_submissions").update({
      status: "rejected", reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", submission.id).in("status", ["awaiting_approval", "failed", "blocked", "queued_to_send"]).select("id"), "Reject") as Array<{ id: string }>;
    if (!updated.length) throw new Error("This image was already handled.");
    await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: "Reviewer chose not to send.", updated_at: new Date().toISOString() })
      .eq("submission_id", submission.id).eq("status", "pending");
    return { notice: "No reply will be sent for this image." };
  });
}

export async function reanalyseSubmission(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const submission = await scopedSubmission(authorization, companyId, field(form, "id"));
    if (["queued", "queued_to_send", "sent"].includes(submission.status)) throw new Error("This image is already queued or sent.");
    check(await reportBotDb().from("report_bot_submissions").update({
      status: "queued", status_reason: null, attempts: 0, next_attempt_at: new Date().toISOString(), locked_until: null, updated_at: new Date().toISOString()
    }).eq("id", submission.id), "Re-analyse");
    return { notice: "Queued for analysis again. Check back in a minute." };
  });
}

export async function setRequestStatus(form: FormData) {
  await mutate("today", async ({ authorization, companyId }) => {
    const status = field(form, "status");
    if (!["received", "cancelled", "pending"].includes(status)) throw new Error("Choose a valid status.");
    const request = check(await reportBotDb().from("report_bot_requests").select("id,group_id").eq("company_id", companyId).eq("id", field(form, "id")).maybeSingle(), "Load request") as { id: string; group_id: string } | null;
    if (!request) throw new Error("Request not found.");
    await scopedGroup(authorization, companyId, request.group_id);
    check(await reportBotDb().from("report_bot_requests").update({
      status, ...(status === "received" ? { received_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString()
    }).eq("id", request.id), "Update request");
    if (status !== "pending") {
      await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: `Marked ${status} by a manager.`, updated_at: new Date().toISOString() })
        .eq("request_id", request.id).eq("status", "pending");
    }
    return { notice: status === "received" ? "Marked as received; no more reminders today." : status === "cancelled" ? "Today's request cancelled; no reminders will be sent." : "Request reopened." };
  });
}

export async function setGroupMode(form: FormData) {
  await mutate("groups", async ({ authorization, companyId }) => {
    const group = await scopedGroup(authorization, companyId, field(form, "group_id"));
    const mode = field(form, "mode") as GroupMode;
    if (!GROUP_MODES.has(mode)) throw new Error("Choose Observe, Review or Live.");
    const name = (check(await reportBotDb().from("report_bot_groups").select("group_name").eq("id", group.id).maybeSingle(), "Load name") as { group_name: string | null } | null)?.group_name ?? "";
    // Safety: never silently put a non-Testing production war-room group into Live from this UI without Review first.
    if (mode === "live" && /tcc3/i.test(name) && !/testing/i.test(name)) {
      throw new Error("Switch TCC3 · Adayar to Live only after an authorised reviewer explicitly confirms the pilot. Use Observe, then Review, first.");
    }
    check(await reportBotDb().from("report_bot_groups").update({ mode, updated_at: new Date().toISOString() }).eq("id", group.id), "Save group mode");
    if (mode === "observe") {
      check(await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: "Group switched to Observe.", updated_at: new Date().toISOString() })
        .eq("group_id", group.id).eq("status", "pending"), "Cancel pending sends");
    }
    return { notice: mode === "observe" ? "Group is in Observe: messages are classified, nothing is sent." : mode === "review" ? "Group is in Review: drafts need approval before any send." : "Group is in Live: auto-replies may post for non high-risk reports when company mode is also Live." };
  });
}

/** Install/update the 10 TCC3 War Room report types for this company (by slug). Does not touch groups. */
export async function installTcc3Templates() {
  await mutate("reports", async ({ authorization, companyId }) => {
    const db = reportBotDb();
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    for (const template of TCC3_REPORT_TEMPLATES) {
      const existing = check(await db.from("report_bot_report_types").select("id").eq("company_id", companyId).eq("slug", template.slug).maybeSingle(), "Load type") as { id: string } | null;
      const row = {
        name: template.name,
        description: template.description,
        rules: template.rules,
        slug: template.slug,
        category: template.category,
        auto_reply_policy: template.auto_reply_policy,
        subtypes: template.subtypes,
        feedback_hint: template.feedback_hint,
        is_active: true,
        updated_at: now
      };
      if (existing) {
        check(await db.from("report_bot_report_types").update(row).eq("id", existing.id), "Update type");
        updated += 1;
      } else {
        check(await db.from("report_bot_report_types").insert({ ...row, company_id: companyId, created_by: authorization.userId }), "Create type");
        created += 1;
      }
    }
    return { notice: `TCC3 templates ready: ${created} created, ${updated} updated. Seed draft schedules only for the Testing group next.` };
  });
}

/** Create inactive draft schedules for one group from TCC3 templates. Never enables them. */
export async function seedDraftSchedulesForGroup(form: FormData) {
  await mutate("reports", async ({ authorization, companyId }) => {
    const group = await scopedGroup(authorization, companyId, field(form, "group_id"));
    const groupRow = check(await reportBotDb().from("report_bot_groups").select("group_name").eq("id", group.id).single(), "Load group") as { group_name: string | null };
    if (/tcc3/i.test(groupRow.group_name ?? "") && !/testing/i.test(groupRow.group_name ?? "")) {
      throw new Error("Do not seed schedules onto TCC3 · Adayar during the pilot. Use the Testing group, then Duplicate configuration later.");
    }
    const db = reportBotDb();
    const types = check(await db.from("report_bot_report_types").select("id,slug").eq("company_id", companyId).not("slug", "is", null), "Load types") as Array<{ id: string; slug: string }>;
    const bySlug = new Map(types.map((row) => [row.slug, row.id]));
    let seeded = 0;
    let skipped = 0;
    for (const template of TCC3_REPORT_TEMPLATES) {
      if (!template.schedule) continue;
      const reportTypeId = bySlug.get(template.slug);
      if (!reportTypeId) throw new Error(`Install TCC3 templates first (missing ${template.slug}).`);
      const existing = check(await db.from("report_bot_schedules").select("id").eq("group_id", group.id).eq("report_type_id", reportTypeId).maybeSingle(), "Check schedule");
      if (existing) {
        skipped += 1;
        continue;
      }
      check(await db.from("report_bot_schedules").insert({
        company_id: companyId,
        group_id: group.id,
        report_type_id: reportTypeId,
        days_of_week: [0, 1, 2, 3, 4, 5, 6],
        reminder_times: template.schedule.reminder_times,
        due_time: template.schedule.due_time,
        first_reminder_template: template.schedule.first_reminder_template,
        followup_template: template.schedule.followup_template,
        overdue_template: template.schedule.overdue_template,
        is_active: false,
        stop_when_received: template.schedule.stop_when_received,
        review_only: template.schedule.review_only,
        schedule_kind: template.schedule.schedule_kind,
        created_by: authorization.userId
      }), "Seed schedule");
      seeded += 1;
    }
    return { notice: `Draft schedules for ${groupRow.group_name ?? "group"}: ${seeded} created (inactive), ${skipped} already present. Confirm timings before enabling any.` };
  });
}

/** Explicit copy of schedules (+ optional report-type link) from one group to another. Never automatic. */
export async function duplicateGroupConfiguration(form: FormData) {
  await mutate("groups", async ({ authorization, companyId }) => {
    const source = await scopedGroup(authorization, companyId, field(form, "source_group_id"));
    const target = await scopedGroup(authorization, companyId, field(form, "target_group_id"));
    if (source.id === target.id) throw new Error("Choose two different groups.");
    const targetRow = check(await reportBotDb().from("report_bot_groups").select("group_name,mode").eq("id", target.id).single(), "Load target") as { group_name: string | null; mode: string };
    if (/tcc3/i.test(targetRow.group_name ?? "") && targetRow.mode !== "observe") {
      throw new Error("Set TCC3 · Adayar to Observe before duplicating configuration onto it.");
    }
    const db = reportBotDb();
    const schedules = check(await db.from("report_bot_schedules").select("*").eq("company_id", companyId).eq("group_id", source.id), "Load source schedules") as Array<Record<string, unknown>>;
    let copied = 0;
    let skipped = 0;
    for (const schedule of schedules) {
      const exists = check(await db.from("report_bot_schedules").select("id").eq("group_id", target.id).eq("report_type_id", schedule.report_type_id as string).maybeSingle(), "Check target");
      if (exists) {
        skipped += 1;
        continue;
      }
      check(await db.from("report_bot_schedules").insert({
        company_id: companyId,
        group_id: target.id,
        report_type_id: schedule.report_type_id,
        days_of_week: schedule.days_of_week,
        reminder_times: schedule.reminder_times,
        due_time: schedule.due_time,
        first_reminder_template: schedule.first_reminder_template,
        followup_template: schedule.followup_template,
        overdue_template: schedule.overdue_template,
        is_active: false,
        stop_when_received: schedule.stop_when_received,
        review_only: schedule.review_only ?? true,
        escalation_delay_minutes: schedule.escalation_delay_minutes ?? 30,
        schedule_kind: schedule.schedule_kind ?? "timed",
        created_by: authorization.userId
      }), "Copy schedule");
      copied += 1;
    }
    check(await db.from("report_bot_groups").update({ mode: "observe", updated_at: new Date().toISOString() }).eq("id", target.id), "Reset target to Observe");
    return { notice: `Copied ${copied} schedule(s) to ${targetRow.group_name ?? "target"} as inactive drafts (${skipped} skipped). Target left in Observe mode.` };
  });
}

export async function approveReviewItem(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const id = field(form, "id");
    const feedback = requiredText(form, "feedback_text", "Feedback", 3000);
    const settings = await loadReportBotSettings(companyId);
    const row = check(await reportBotDb().from("report_bot_review_items")
      .select("id,group_id,submission_id,review_status, primary_event:report_bot_inbound_events(wa_message_id,sender_jid), group:report_bot_groups(location_id,mode,is_enabled)")
      .eq("company_id", companyId).eq("id", id).maybeSingle(), "Load review") as unknown as {
        id: string; group_id: string; submission_id: string | null; review_status: string;
        primary_event: { wa_message_id: string; sender_jid: string | null } | null;
        group: { location_id: string | null; mode: GroupMode; is_enabled: boolean } | null;
      } | null;
    if (!row || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) throw new Error("This review item is not available to you.");
    if (!["draft_ready", "observe_only"].includes(row.review_status)) throw new Error("This item was already handled.");
    if (!row.group?.is_enabled || !canSendToGroup(settings.mode, row.group.mode ?? "observe")) {
      throw new Error("Company must be Live and this group must be Review or Live to send.");
    }
    const updated = check(await reportBotDb().from("report_bot_review_items").update({
      review_status: "approved",
      feedback_draft: feedback,
      reviewed_by: authorization.userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", id).in("review_status", ["draft_ready", "observe_only"]).select("id"), "Approve review") as Array<{ id: string }>;
    if (!updated.length) throw new Error("Someone already handled this item.");
    await reportBotDb().from("report_bot_review_audit").insert({
      company_id: companyId, review_id: id, action: "approved", actor_user_id: authorization.userId, detail: { feedback }
    });
    if (row.submission_id) {
      check(await reportBotDb().from("report_bot_submissions").update({
        status: "queued_to_send", feedback_text: feedback, reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("id", row.submission_id).in("status", ["awaiting_approval", "failed", "ignored"]), "Approve submission");
      await reportBotDb().from("report_bot_outbox").delete().eq("company_id", companyId).eq("dedupe_key", `feedback:${row.submission_id}`).in("status", ["failed", "cancelled"]);
      await queueFeedback(settings, {
        id: row.submission_id,
        company_id: companyId,
        group_id: row.group_id,
        wa_message_id: row.primary_event?.wa_message_id ?? "",
        sender_jid: row.primary_event?.sender_jid ?? null
      }, feedback, authorization.userId, { immediate: true });
      const notice = await sendNow(settings, [row.submission_id]);
      const sentRow = check(await reportBotDb().from("report_bot_submissions").select("status").eq("id", row.submission_id).single(), "Check send") as { status: string };
      if (sentRow.status === "sent") {
        await reportBotDb().from("report_bot_review_items").update({ review_status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
        await reportBotDb().from("report_bot_review_audit").insert({
          company_id: companyId, review_id: id, action: "sent", actor_user_id: authorization.userId, detail: {}
        });
      }
      return { notice };
    }
    const event = row.primary_event;
    if (!event?.wa_message_id) throw new Error("No message to quote for this reply.");
    const dedupe = `feedback-review:${id}`;
    check(await reportBotDb().from("report_bot_outbox").insert({
      company_id: companyId,
      group_id: row.group_id,
      kind: "feedback",
      dedupe_key: dedupe,
      body: feedback,
      quoted_message_id: event.wa_message_id,
      quoted_participant: event.sender_jid,
      not_before: new Date().toISOString(),
      stale_after: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      created_by: authorization.userId
    }), "Queue feedback");
    try {
      await flushOutbox(settings, Date.now() + 45_000);
    } catch {
      // cron retries
    }
    const out = check(await reportBotDb().from("report_bot_outbox").select("status").eq("company_id", companyId).eq("dedupe_key", dedupe).single(), "Check send") as { status: string };
    if (out.status === "sent") {
      check(await reportBotDb().from("report_bot_review_items").update({ review_status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id), "Mark sent");
      await reportBotDb().from("report_bot_review_audit").insert({ company_id: companyId, review_id: id, action: "sent", actor_user_id: authorization.userId, detail: {} });
      return { notice: "Reply posted in the group." };
    }
    return { notice: "Approved and queued; it goes out within a minute." };
  });
}

export async function dismissReviewItem(form: FormData) {
  await mutate("review", async ({ authorization, companyId }) => {
    const id = field(form, "id");
    const row = check(await reportBotDb().from("report_bot_review_items")
      .select("id,submission_id, group:report_bot_groups(location_id)")
      .eq("company_id", companyId).eq("id", id).maybeSingle(), "Load review") as unknown as {
        id: string; submission_id: string | null; group: { location_id: string | null } | null;
      } | null;
    if (!row || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) throw new Error("This review item is not available to you.");
    const updated = check(await reportBotDb().from("report_bot_review_items").update({
      review_status: "dismissed", reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("id", id).in("review_status", ["draft_ready", "observe_only", "approved"]).select("id"), "Dismiss") as Array<{ id: string }>;
    if (!updated.length) throw new Error("This item was already handled.");
    await reportBotDb().from("report_bot_review_audit").insert({
      company_id: companyId, review_id: id, action: "dismissed", actor_user_id: authorization.userId, detail: {}
    });
    if (row.submission_id) {
      await reportBotDb().from("report_bot_submissions").update({ status: "rejected", reviewed_by: authorization.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.submission_id).in("status", ["awaiting_approval", "queued_to_send", "failed"]);
      await reportBotDb().from("report_bot_outbox").update({ status: "cancelled", status_reason: "Reviewer dismissed.", updated_at: new Date().toISOString() })
        .eq("submission_id", row.submission_id).eq("status", "pending");
    }
    return { notice: "Dismissed. No reply will be sent." };
  });
}

export async function closeOpenAction(form: FormData) {
  await mutate("actions", async ({ authorization, companyId }) => {
    const id = field(form, "id");
    const note = field(form, "closure_note").slice(0, 500) || null;
    const row = check(await reportBotDb().from("report_bot_actions")
      .select("id, group:report_bot_groups(location_id)")
      .eq("company_id", companyId).eq("id", id).maybeSingle(), "Load action") as unknown as {
        id: string; group: { location_id: string | null } | null;
      } | null;
    if (!row || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) throw new Error("This action is not available to you.");
    check(await reportBotDb().from("report_bot_actions").update({
      status: "closed",
      closure_note: note,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", id).in("status", ["open", "pending_evidence", "unmatched_closure"]), "Close action");
    return { notice: "Action marked closed." };
  });
}

/** Dry-run preview of today's remaining reminder slots for a schedule. */
export async function previewScheduleReminders(form: FormData) {
  await mutate("reports", async ({ authorization, companyId }) => {
    const settings = await loadReportBotSettings(companyId);
    const schedule = check(await reportBotDb().from("report_bot_schedules")
      .select("id,group_id,due_time,reminder_times,is_active")
      .eq("company_id", companyId).eq("id", field(form, "id")).maybeSingle(), "Load schedule") as {
        id: string; group_id: string; due_time: string; reminder_times: string[]; is_active: boolean;
      } | null;
    if (!schedule) throw new Error("Schedule not found.");
    await scopedGroup(authorization, companyId, schedule.group_id);
    const clock = localClock(new Date(), settings.timezone);
    const preview = previewReminderSlots(schedule.reminder_times ?? [], schedule.due_time, clock.minutes);
    const upcoming = preview.upcoming.map((slot) => slot.label).join(", ") || "none left today";
    return { notice: `Preview (${schedule.is_active ? "active" : "draft/inactive"}): due ${formatClock(schedule.due_time)}; upcoming reminders today: ${upcoming}; ${preview.past_today} slot(s) already past.` };
  });
}
