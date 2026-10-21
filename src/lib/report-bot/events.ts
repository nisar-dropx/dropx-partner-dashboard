import "server-only";
import { AI_TIMEOUT_MS, AiError, analyseOperationalReport, type CandidateReport } from "@/lib/report-bot/ai";
import { fetchReportImage } from "@/lib/report-bot/image";
import {
  canAutoSendToGroup,
  composeFeedback,
  decideGroupDelivery,
  displayDate,
  findCorrelationBundle,
  localClock,
  mentionFor,
  randomDelaySeconds,
  reviewStatusFor,
  senderLabel,
  sniffImageType,
  type GroupMode
} from "@/lib/report-bot/logic";
import { reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";

type InboundRow = {
  id: string;
  company_id: string;
  group_id: string;
  wa_message_id: string;
  sender_jid: string | null;
  sender_name: string | null;
  message_at: string;
  message_type: string;
  text_body: string | null;
  caption: string | null;
  quoted_message_id: string | null;
  media_ref: string | null;
  wa_message_record: string | null;
  bundle_id: string | null;
  submission_id: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function must<T>(result: { data: T | null; error: { message: string } | null }, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data as T;
}

async function candidatesForGroup(settings: ReportBotSettings, groupId: string, businessDate: string) {
  const db = reportBotDb();
  const requests = must(await db.from("report_bot_requests")
    .select("id,status,report_type_id, report:report_bot_report_types(id,name,description,rules,is_active,category,subtypes,auto_reply_policy,feedback_hint)")
    .eq("group_id", groupId)
    .eq("business_date", businessDate)
    .in("status", ["pending", "overdue", "received", "missed"]), "Load requests") as unknown as Array<{
      id: string; status: string; report_type_id: string;
      report: CandidateReport & { is_active: boolean } | null;
    }>;
  const open = requests.filter((row) => row.report?.is_active);
  if (open.length) {
    return {
      requests: open,
      candidates: [...new Map(open.map((row) => [row.report!.id, {
        id: row.report!.id,
        name: row.report!.name,
        description: row.report!.description,
        rules: row.report!.rules ?? [],
        category: row.report!.category,
        subtypes: row.report!.subtypes,
        auto_reply_policy: row.report!.auto_reply_policy,
        feedback_hint: row.report!.feedback_hint
      }])).values()] as CandidateReport[]
    };
  }
  // Event-driven reports (load receipt, incidents) may have no open daily request.
  // Prefer types linked to this group via any schedule, then all active company types.
  const scheduled = must(await db.from("report_bot_schedules")
    .select("report:report_bot_report_types(id,name,description,rules,is_active,category,subtypes,auto_reply_policy,feedback_hint)")
    .eq("group_id", groupId), "Load group schedules") as unknown as Array<{ report: CandidateReport & { is_active: boolean } | null }>;
  const fromSchedules = scheduled.flatMap((row) => (row.report?.is_active ? [toCandidate(row.report)] : []));
  if (fromSchedules.length) return { requests: [], candidates: [...new Map(fromSchedules.map((row) => [row.id, row])).values()] };
  // Classification uses the company catalog even when no schedule exists yet (event-driven reports).
  const types = must(await db.from("report_bot_report_types")
    .select("id,name,description,rules,category,subtypes,auto_reply_policy,feedback_hint,is_active")
    .eq("company_id", settings.company_id)
    .eq("is_active", true), "Load report types") as Array<CandidateReport & { is_active: boolean }>;
  return { requests: [], candidates: types.map(toCandidate) };
}

function toCandidate(row: CandidateReport & { is_active?: boolean }): CandidateReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: row.rules ?? [],
    category: row.category,
    subtypes: row.subtypes,
    auto_reply_policy: row.auto_reply_policy,
    feedback_hint: row.feedback_hint
  };
}

async function writeAudit(companyId: string, reviewId: string, action: string, detail: Record<string, unknown> = {}, actor: string | null = null) {
  await reportBotDb().from("report_bot_review_audit").insert({
    company_id: companyId,
    review_id: reviewId,
    action,
    actor_user_id: actor,
    detail
  });
}

async function upsertActionsFromAnalysis(
  settings: ReportBotSettings,
  groupId: string,
  reviewId: string,
  eventId: string,
  analysis: Awaited<ReturnType<typeof analyseOperationalReport>>
) {
  if (!analysis.open_actions.length) return;
  const db = reportBotDb();
  for (const action of analysis.open_actions) {
    await db.from("report_bot_actions").insert({
      company_id: settings.company_id,
      group_id: groupId,
      title: action.title,
      category: action.category,
      owner_name: action.owner,
      status: "open",
      high_risk: action.high_risk,
      source_event_id: eventId,
      source_review_id: reviewId
    });
  }
}

async function tryLinkTicketClosure(
  settings: ReportBotSettings,
  groupId: string,
  eventId: string,
  reviewId: string,
  analysis: Awaited<ReturnType<typeof analyseOperationalReport>>,
  reportCategory: string | null
) {
  if (reportCategory !== "closure" && !/ticket|tt|closure|reconcil/i.test(analysis.extracted_summary)) return;
  const db = reportBotDb();
  const refs = analysis.extracted_fields
    .filter((field) => /ticket|tt|ref/i.test(field.label))
    .map((field) => field.value.toLowerCase());
  const open = must(await db.from("report_bot_actions")
    .select("id,title")
    .eq("company_id", settings.company_id)
    .eq("group_id", groupId)
    .in("status", ["open", "pending_evidence"])
    .order("created_at", { ascending: false })
    .limit(50), "Load open actions") as Array<{ id: string; title: string }>;
  const match = open.find((row) => refs.some((ref) => row.title.toLowerCase().includes(ref)) || refs.some((ref) => analysis.extracted_summary.toLowerCase().includes(ref) && row.title.toLowerCase().includes(ref.slice(0, 6))));
  if (match) {
    must(await db.from("report_bot_actions").update({
      status: "closed",
      closure_event_id: eventId,
      closure_note: analysis.extracted_summary.slice(0, 500),
      closed_at: nowIso(),
      updated_at: nowIso()
    }).eq("id", match.id), "Close action");
    return;
  }
  await db.from("report_bot_actions").insert({
    company_id: settings.company_id,
    group_id: groupId,
    title: truncateTitle(analysis.extracted_summary || "Unmatched closure"),
    category: "closure",
    status: "unmatched_closure",
    source_event_id: eventId,
    source_review_id: reviewId,
    high_risk: false
  });
}

function truncateTitle(value: string) {
  const text = value.trim();
  return text.length <= 300 ? text || "Unmatched closure" : `${text.slice(0, 299)}…`;
}

/** Correlate + classify a newly stored inbound event (text or image metadata). */
export async function processInboundEvent(settings: ReportBotSettings, eventId: string, deadline: number) {
  if (settings.mode === "off") return;
  if (Date.now() >= deadline - AI_TIMEOUT_MS - 20_000) return;
  const db = reportBotDb();
  const event = must(await db.from("report_bot_inbound_events").select("*").eq("id", eventId).maybeSingle(), "Load inbound event") as InboundRow | null;
  if (!event) return;

  const group = must(await db.from("report_bot_groups")
    .select("id,group_name,is_enabled,mode,location_id, station:stations(station_code,station_name)")
    .eq("id", event.group_id).single(), "Load group") as unknown as {
      id: string; group_name: string | null; is_enabled: boolean; mode: GroupMode | null;
      station: { station_code: string; station_name: string | null } | null;
    };
  if (!group.is_enabled) return;
  const groupMode: GroupMode = group.mode === "review" || group.mode === "live" ? group.mode : "observe";

  const windowMinutes = Number(settings.correlation_window_minutes ?? 10);
  let bundleId = event.bundle_id;
  if (!bundleId) {
    const since = new Date(new Date(event.message_at).getTime() - windowMinutes * 60_000).toISOString();
    // PostgREST eq(null) does not match NULL rows; use is() for unknown senders.
    const peerBase = db.from("report_bot_inbound_events")
      .select("id,bundle_id,message_at")
      .eq("group_id", event.group_id)
      .gte("message_at", since)
      .neq("id", event.id)
      .order("message_at", { ascending: false })
      .limit(20);
    const peers = must(
      await (event.sender_jid == null ? peerBase.is("sender_jid", null) : peerBase.eq("sender_jid", event.sender_jid)),
      "Load peer events"
    ) as Array<{ id: string; bundle_id: string | null; message_at: string }>;
    bundleId = findCorrelationBundle(peers, new Date(event.message_at), windowMinutes) ?? event.id;
    must(await db.from("report_bot_inbound_events").update({ bundle_id: bundleId }).eq("id", event.id), "Save bundle");
  }

  const bundle = must(await db.from("report_bot_inbound_events")
    .select("*")
    .eq("bundle_id", bundleId)
    .order("message_at", { ascending: true }), "Load bundle") as InboundRow[];

  // One open review per bundle. If later evidence joins the same bundle, reclassify.
  const existing = await db.from("report_bot_review_items")
    .select("id,review_status,primary_event_id")
    .eq("company_id", settings.company_id)
    .eq("bundle_id", bundleId)
    .maybeSingle();
  if (existing.data?.id) {
    const open = ["observe_only", "draft_ready"].includes(existing.data.review_status);
    const newEvidence = existing.data.primary_event_id !== event.id;
    if (!open || !newEvidence) return;
    await db.from("report_bot_review_audit").delete().eq("review_id", existing.data.id);
    await db.from("report_bot_actions").update({ source_review_id: null }).eq("source_review_id", existing.data.id);
    must(await db.from("report_bot_review_items").delete().eq("id", existing.data.id), "Clear stale bundle review");
  }

  const businessDate = localClock(new Date(event.message_at), settings.timezone).date;
  const { requests, candidates } = await candidatesForGroup(settings, event.group_id, businessDate);
  if (!candidates.length) return;

  const bundleTexts = bundle.flatMap((row) => [row.text_body, row.caption].filter((part): part is string => Boolean(part?.trim())));
  const imageRow = [...bundle].reverse().find((row) => row.media_ref);
  let image: Uint8Array | null = null;
  let mime: "image/jpeg" | "image/png" | "image/webp" | null = null;
  if (imageRow?.media_ref) {
    try {
      image = await fetchReportImage(settings, imageRow.media_ref, imageRow.wa_message_record);
      mime = sniffImageType(image);
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      // Text-only classification can still proceed when the image cannot be fetched.
      if (!bundleTexts.length) throw error;
    }
  }

  const analysis = await analyseOperationalReport(settings, {
    image,
    mime,
    text: event.text_body,
    caption: event.caption,
    bundleTexts,
    candidates,
    groupName: group.group_name ?? "group",
    stationLabel: group.station ? [group.station.station_code, group.station.station_name].filter(Boolean).join(" · ") : null,
    businessDate
  });

  const reportType = candidates.find((candidate) => candidate.id === analysis.matched_report_type_id) ?? null;
  const request = reportType ? requests.find((row) => row.report_type_id === reportType.id) ?? null : null;
  const decision = decideGroupDelivery(analysis, settings, {
    companyMode: settings.mode,
    groupMode,
    autoReplyPolicy: reportType?.auto_reply_policy,
    category: reportType?.category,
    highRiskActions: analysis.open_actions.some((action) => action.high_risk)
  });
  const feedback = decision === "silent" ? null : composeFeedback(settings, {
    verdict: analysis.verdict,
    feedback: analysis.feedback || reportType?.feedback_hint || "",
    report: reportType?.name ?? "Report",
    sender: mentionFor(event.sender_jid)?.text ?? senderLabel(event.sender_name, event.sender_jid),
    group: group.group_name ?? "",
    date: displayDate(businessDate),
    checks: analysis.checks
  });
  const reviewStatus = reviewStatusFor(groupMode, decision, Boolean(feedback?.trim()));

  const inserted = must(await db.from("report_bot_review_items").insert({
    company_id: settings.company_id,
    group_id: event.group_id,
    bundle_id: bundleId,
    primary_event_id: event.id,
    submission_id: imageRow?.submission_id ?? event.submission_id,
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
    status_reason: decision === "silent" ? "Not an operational report." : null,
    updated_at: nowIso()
  }).select("id").single(), "Create review item") as { id: string };

  await writeAudit(settings.company_id, inserted.id, "created", { verdict: analysis.verdict, review_status: reviewStatus });

  if (analysis.is_report) {
    await upsertActionsFromAnalysis(settings, event.group_id, inserted.id, event.id, analysis);
    await tryLinkTicketClosure(settings, event.group_id, event.id, inserted.id, analysis, reportType?.category ?? null);
  }
  if (request && analysis.is_report) {
    must(await db.from("report_bot_requests").update({
      status: "received",
      ...(request.status === "received" ? {} : { received_at: event.message_at }),
      last_verdict: analysis.verdict,
      updated_at: nowIso()
    }).eq("id", request.id).in("status", ["pending", "overdue", "received", "missed"]), "Mark request received");
  }

  // Keep legacy submission row in sync when this bundle has an image submission.
  if (imageRow?.submission_id) {
    const submissionStatus = decision === "silent" ? "ignored" : decision === "auto_send" && canAutoSendToGroup(settings.mode, groupMode) ? "queued_to_send" : "awaiting_approval";
    await db.from("report_bot_submissions").update({
      status: submissionStatus,
      report_type_id: reportType?.id ?? null,
      request_id: request?.id ?? null,
      ai_provider: settings.ai_provider,
      ai_model: settings.ai_model,
      ai_result: analysis,
      verdict: analysis.verdict,
      confidence: analysis.confidence,
      feedback_text: feedback,
      review_id: inserted.id,
      locked_until: null,
      updated_at: nowIso()
    }).eq("id", imageRow.submission_id).in("status", ["queued", "awaiting_approval"]);
    if (decision === "auto_send" && feedback && canAutoSendToGroup(settings.mode, groupMode)) {
      const mention = mentionFor(imageRow.sender_jid);
      const delay = randomDelaySeconds(settings.reply_delay_min_seconds, settings.reply_delay_max_seconds);
      await db.from("report_bot_outbox").upsert({
        company_id: settings.company_id,
        group_id: event.group_id,
        kind: "feedback",
        dedupe_key: `feedback:${imageRow.submission_id}`,
        body: feedback,
        quoted_message_id: imageRow.wa_message_id,
        quoted_participant: imageRow.sender_jid,
        mentions: mention && feedback.includes(mention.text) ? [mention.jid] : [],
        submission_id: imageRow.submission_id,
        not_before: new Date(Date.now() + delay * 1000).toISOString(),
        stale_after: new Date(Date.now() + (delay + 12 * 3600) * 1000).toISOString()
      }, { onConflict: "company_id,dedupe_key", ignoreDuplicates: true });
      await db.from("report_bot_review_items").update({ review_status: "approved", updated_at: nowIso() }).eq("id", inserted.id);
    }
  }
}

export async function pruneInboundEvents(settings: ReportBotSettings) {
  const days = Number((settings as ReportBotSettings & { inbound_retention_days?: number }).inbound_retention_days ?? 30);
  const result = await reportBotDb().rpc("report_bot_prune_inbound_events", {
    p_company_id: settings.company_id,
    p_retention_days: days
  });
  if (result.error) throw new Error(`Prune inbound events: ${result.error.message}`);
  return Number(result.data ?? 0);
}

/** Rebuild the daily site summary JSON for a group/date from reviews and actions. */
export async function refreshDailySummary(settings: ReportBotSettings, groupId: string, businessDate: string) {
  const db = reportBotDb();
  const start = `${businessDate}T00:00:00.000Z`;
  const end = `${businessDate}T23:59:59.999Z`;
  const [reviews, actions] = await Promise.all([
    db.from("report_bot_review_items").select("verdict,report_type_id,extracted_facts,open_actions, review:report_bot_report_types(slug,category,name)")
      .eq("group_id", groupId).gte("created_at", start).lte("created_at", end),
    db.from("report_bot_actions").select("title,category,status,high_risk,owner_name,created_at,closed_at")
      .eq("group_id", groupId).gte("created_at", start)
  ]);
  // Supabase types the joined report relation as an array; normalise to one object.
  const reviewRows = ((reviews.data ?? []) as unknown as Array<{
    verdict: string | null;
    extracted_facts: unknown;
    open_actions: unknown;
    review: { slug: string | null; category: string | null; name: string } | Array<{ slug: string | null; category: string | null; name: string }> | null;
  }>).map((row) => ({
    ...row,
    review: Array.isArray(row.review) ? row.review[0] ?? null : row.review
  }));
  const actionRows = (actions.data ?? []) as Array<{ title: string; category: string; status: string; high_risk: boolean; owner_name: string | null }>;
  const byCategory = (category: string) => reviewRows.filter((row) => row.review?.category === category || row.review?.slug?.includes(category));
  const summary = {
    loads_received: byCategory("load").length,
    shortages_damage_totes: reviewRows.filter((row) => /shortage|damage|tote/i.test(JSON.stringify(row.extracted_facts ?? ""))).length,
    ppi_o2a_exceptions: byCategory("metrics").filter((row) => row.verdict === "fail" || row.verdict === "needs_review").length,
    manpower_exceptions: byCategory("workforce").length + actionRows.filter((row) => row.category === "workforce").length,
    expiry_fefo: byCategory("expiry").length,
    temperature_infrastructure: byCategory("cold_chain").length + byCategory("infrastructure").length,
    unresolved_actions: actionRows.filter((row) => ["open", "pending_evidence", "unmatched_closure"].includes(row.status)).map((row) => ({
      title: row.title,
      category: row.category,
      owner: row.owner_name,
      high_risk: row.high_risk,
      status: row.status
    })),
    report_counts: reviewRows.reduce<Record<string, number>>((acc, row) => {
      const key = row.review?.name ?? "Other";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})
  };
  must(await db.from("report_bot_daily_summaries").upsert({
    company_id: settings.company_id,
    group_id: groupId,
    business_date: businessDate,
    summary,
    updated_at: nowIso()
  }, { onConflict: "group_id,business_date" }), "Save daily summary");
  return summary;
}
