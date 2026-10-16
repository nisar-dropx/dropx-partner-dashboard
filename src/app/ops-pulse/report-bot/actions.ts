"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canSeeGroup, REPORT_BOT_PAGE } from "@/lib/report-bot/access";
import { isValidTimeZone, normalizeDays, normalizeTimeList, parseClockTime } from "@/lib/report-bot/logic";
import { flushOutbox, queueFeedback } from "@/lib/report-bot/pipeline";
import {
  generateWorkerToken,
  hashWorkerToken,
  loadReportBotSettings,
  reportBotDb,
  type ReportBotSettings
} from "@/lib/report-bot/settings";
import { workerRequest } from "@/lib/report-bot/worker-client";

const FLASH_COOKIE = "dropx_report_bot_flash";
const TABS = new Set(["today", "review", "groups", "reports", "connection", "settings"]);

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

function field(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
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
  const group = check(await reportBotDb().from("report_bot_groups").select("id,location_id,is_enabled,wa_group_id").eq("company_id", companyId).eq("id", groupId).maybeSingle(), "Load group");
  if (!group || !canSeeGroup(authorization, group)) throw new Error("This group is not available to you.");
  return group as { id: string; location_id: string | null; is_enabled: boolean; wa_group_id: string };
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
