import { NextResponse } from "next/server";
import { canSeeGroup, reportBotApiAuthorization } from "@/lib/report-bot/access";
import { loadReportBotSettings, reportBotDb } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";

type WorkerChatEntry = {
  id: string; from: string | null; name: string | null; from_me: boolean; bot: boolean; ts: number; type: string; text: string | null;
  quoted: { id: string; from: string | null; type: string; text: string | null } | null; mentions: string[];
};
type WorkerChats = { messages: WorkerChatEntry[]; names: Record<string, string>; since: number; connected: boolean; subject: string | null; size: number | null };

export type ChatMessage = WorkerChatEntry & {
  report: { submission_id: string; verdict: string | null; status: string; has_image: boolean } | null;
  kind: string | null;
};

const HISTORY_HOURS = 72;

/**
 * Messages for one group's chat view: live from the worker (text, photos, replies),
 * enriched with what the portal knows (report verdicts, bot reply kind). When the worker
 * is unreachable, the stored report photos and sent replies are shown instead.
 */
export async function GET(request: Request) {
  const authorization = await reportBotApiAuthorization("access");
  if (!authorization) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  const groupId = new URL(request.url).searchParams.get("group") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return NextResponse.json({ error: "Choose a group." }, { status: 400 });
  const db = reportBotDb();
  const group = await db.from("report_bot_groups").select("id,wa_group_id,group_name,participant_count,location_id,is_enabled")
    .eq("company_id", authorization.companyId!).eq("id", groupId).maybeSingle();
  if (!group.data || !canSeeGroup(authorization, group.data)) return NextResponse.json({ error: "Group not found." }, { status: 404 });

  const since = new Date(Date.now() - HISTORY_HOURS * 3600 * 1000).toISOString();
  const [submissions, outbox] = await Promise.all([
    db.from("report_bot_submissions").select("id,wa_message_id,sender_jid,sender_name,from_me,caption,message_at,verdict,status,media_ref")
      .eq("group_id", groupId).gte("message_at", since).order("message_at").limit(500),
    db.from("report_bot_outbox").select("id,kind,body,sent_wa_message_id,sent_at,quoted_message_id,quoted_participant,mentions")
      .eq("group_id", groupId).eq("status", "sent").gte("sent_at", since).order("sent_at").limit(500)
  ]);
  const reportByMessage = new Map((submissions.data ?? []).map((row) => [row.wa_message_id, row]));
  const kindBySent = new Map((outbox.data ?? []).filter((row) => row.sent_wa_message_id).map((row) => [row.sent_wa_message_id as string, row.kind]));
  const names: Record<string, string> = {};
  for (const row of submissions.data ?? []) if (row.sender_jid && row.sender_name) names[row.sender_jid] = row.sender_name;

  let live: WorkerChats | null = null;
  let liveError: string | null = null;
  if (group.data.is_enabled) {
    const settings = await loadReportBotSettings(authorization.companyId!);
    if (settings.mode === "off") {
      // An Off bot listens to no group, so the worker has no live messages to show.
      liveError = "The bot is Off, so live messages aren't collected. Showing stored reports and replies.";
    } else {
      try {
        live = await workerRequest<WorkerChats>(settings, `/chats?group=${encodeURIComponent(group.data.wa_group_id)}`, { timeoutMs: 8000 });
      } catch (error) {
        liveError = error instanceof WorkerError
          ? error.status === 404 ? "The worker hasn't picked up this group yet (it refreshes within a minute)." : error.message
          : "The worker is unreachable.";
      }
    }
  } else {
    liveError = "This group is turned off, so only stored reports and replies are shown.";
  }

  const enrich = (entry: WorkerChatEntry): ChatMessage => {
    const report = reportByMessage.get(entry.id);
    return {
      ...entry,
      report: report ? { submission_id: report.id, verdict: report.verdict, status: report.status, has_image: Boolean(report.media_ref) } : null,
      kind: kindBySent.get(entry.id) ?? null
    };
  };

  let messages: ChatMessage[];
  if (live) {
    messages = live.messages.map(enrich);
    // Anything older than the worker's memory still appears from the stored history.
    const seen = new Set(messages.map((message) => message.id));
    const older: ChatMessage[] = [];
    for (const row of submissions.data ?? []) {
      const ts = Math.floor(new Date(row.message_at).getTime() / 1000);
      if (seen.has(row.wa_message_id) || ts >= live.since) continue;
      older.push(enrich({ id: row.wa_message_id, from: row.sender_jid, name: row.sender_name, from_me: row.from_me, bot: false, ts, type: "image", text: row.caption, quoted: null, mentions: [] }));
    }
    for (const row of outbox.data ?? []) {
      const ts = Math.floor(new Date(row.sent_at as string).getTime() / 1000);
      if (!row.sent_wa_message_id || seen.has(row.sent_wa_message_id) || ts >= live.since) continue;
      older.push(enrich({ id: row.sent_wa_message_id, from: null, name: null, from_me: true, bot: true, ts, type: "text", text: row.body, quoted: row.quoted_message_id ? { id: row.quoted_message_id, from: row.quoted_participant, type: "image", text: reportByMessage.get(row.quoted_message_id)?.caption ?? null } : null, mentions: row.mentions ?? [] }));
    }
    messages = [...older, ...messages].sort((a, b) => a.ts - b.ts);
    Object.assign(names, live.names);
  } else {
    messages = [
      ...(submissions.data ?? []).map((row) => enrich({ id: row.wa_message_id, from: row.sender_jid, name: row.sender_name, from_me: row.from_me, bot: false, ts: Math.floor(new Date(row.message_at).getTime() / 1000), type: "image", text: row.caption, quoted: null, mentions: [] })),
      ...(outbox.data ?? []).filter((row) => row.sent_wa_message_id).map((row) => enrich({ id: row.sent_wa_message_id as string, from: null, name: null, from_me: true, bot: true, ts: Math.floor(new Date(row.sent_at as string).getTime() / 1000), type: "text", text: row.body, quoted: row.quoted_message_id ? { id: row.quoted_message_id, from: row.quoted_participant, type: "image", text: reportByMessage.get(row.quoted_message_id)?.caption ?? null } : null, mentions: row.mentions ?? [] }))
    ].sort((a, b) => a.ts - b.ts);
  }

  return NextResponse.json({
    group: { id: group.data.id, name: live?.subject || group.data.group_name || "Group", size: live?.size ?? group.data.participant_count, enabled: group.data.is_enabled },
    live: Boolean(live),
    connected: live?.connected ?? false,
    since: live?.since ?? null,
    notice: liveError,
    names,
    messages
  }, { headers: { "cache-control": "no-store" } });
}
