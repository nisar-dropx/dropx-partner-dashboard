import { NextResponse } from "next/server";
import { isGroupJid, truncateText } from "@/lib/report-bot/logic";
import { reportBotDb, settingsForWorkerRequest } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";

const MAX_EVENTS = 50;
// WhatsApp replays history after a re-link; anything older is not a fresh submission.
const MAX_MESSAGE_AGE_MS = 6 * 60 * 60 * 1000;
const CONNECTION_STATES = new Set(["idle", "connecting", "qr", "pairing", "open", "closed", "logged_out"]);

type WorkerEvent = Record<string, unknown>;

function text(value: unknown, max: number) {
  return typeof value === "string" ? truncateText(value, max) || null : null;
}

export async function POST(request: Request) {
  let settings;
  try {
    settings = await settingsForWorkerRequest(request);
  } catch {
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
  if (!settings) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as { events?: unknown } | null;
  if (!body || !Array.isArray(body.events) || body.events.length > MAX_EVENTS) {
    return NextResponse.json({ error: `Send between 1 and ${MAX_EVENTS} events.` }, { status: 400 });
  }
  const db = reportBotDb();
  const companyId = settings.company_id;
  const now = new Date().toISOString();
  const counts = { accepted: 0, ignored: 0 };

  // Every worker call proves it is alive, even an empty heartbeat batch.
  await db.from("report_bot_settings").update({ last_worker_seen_at: now }).eq("company_id", companyId);

  for (const raw of body.events as WorkerEvent[]) {
    if (!raw || typeof raw !== "object") {
      counts.ignored += 1;
      continue;
    }
    const type = raw.type;
    if (type === "status") {
      const state = String(raw.state ?? "");
      if (!CONNECTION_STATES.has(state)) {
        counts.ignored += 1;
        continue;
      }
      const me = raw.me && typeof raw.me === "object" ? raw.me as { id?: unknown; name?: unknown } : null;
      const number = typeof me?.id === "string" ? me.id.split("@")[0].split(":")[0] : null;
      // A hosted worker announces its own https address, so nobody has to copy it into the portal.
      const publicUrl = typeof raw.public_url === "string" && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(raw.public_url) ? raw.public_url.replace(/\/+$/, "") : null;
      const result = await db.from("report_bot_settings").update({
        ...(publicUrl ? { worker_url: publicUrl } : {}),
        connection_state: state,
        connected_number: state === "open" ? number : state === "logged_out" ? null : settings.connected_number,
        connected_name: state === "open" ? text(me?.name, 80) : state === "logged_out" ? null : settings.connected_name,
        connection_error: text(raw.error, 300),
        last_worker_seen_at: now
      }).eq("company_id", companyId);
      if (result.error) return NextResponse.json({ error: "Could not save status" }, { status: 500 });
      counts.accepted += 1;
      continue;
    }

    const groupJid = String(raw.group_id ?? "");
    if (!isGroupJid(groupJid)) {
      counts.ignored += 1;
      continue;
    }

    if (type === "group_left" || type === "group_updated") {
      const update = type === "group_left"
        ? { bot_in_group: false, updated_at: now }
        : {
          ...(text(raw.group_name, 200) ? { group_name: text(raw.group_name, 200) } : {}),
          ...(Number.isInteger(raw.size) ? { participant_count: raw.size } : {}),
          bot_in_group: true,
          updated_at: now
        };
      const result = await db.from("report_bot_groups").update(update).eq("company_id", companyId).eq("wa_group_id", groupJid);
      if (result.error) return NextResponse.json({ error: "Could not save group change" }, { status: 500 });
      counts.accepted += 1;
      continue;
    }

    if (type !== "message") {
      counts.ignored += 1;
      continue;
    }
    const messageId = String(raw.message_id ?? "");
    const media = raw.media && typeof raw.media === "object" ? raw.media as { ref?: unknown; mime?: unknown; size?: unknown } : null;
    const mediaRef = typeof media?.ref === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(media.ref) ? media.ref : null;
    const timestampMs = Number(raw.timestamp) * 1000;
    const tooOld = !Number.isFinite(timestampMs) || Date.now() - timestampMs > MAX_MESSAGE_AGE_MS;
    const fromMe = raw.from_me === true;
    if (!/^[A-Za-z0-9_.:-]{6,128}$/.test(messageId) || !mediaRef || tooOld || raw.sent_by_bot === true || (fromMe && !settings.include_own_messages)) {
      counts.ignored += 1;
      continue;
    }
    const group = await db.from("report_bot_groups").select("id,is_enabled").eq("company_id", companyId).eq("wa_group_id", groupJid).maybeSingle();
    if (group.error) return NextResponse.json({ error: "Could not load group" }, { status: 500 });
    if (!group.data?.is_enabled) {
      counts.ignored += 1;
      continue;
    }
    const inserted = await db.from("report_bot_submissions").upsert({
      company_id: companyId,
      group_id: group.data.id,
      wa_message_id: messageId,
      sender_jid: text(raw.sender_jid, 120),
      sender_name: text(raw.sender_name, 120),
      from_me: fromMe,
      caption: text(raw.caption, 1000),
      message_at: new Date(Math.min(timestampMs, Date.now())).toISOString(),
      media_ref: mediaRef,
      media_mime: text(media?.mime, 100),
      wa_message_record: typeof raw.message_record === "string" && raw.message_record.length <= 100_000 ? raw.message_record : null,
      media_size: Number.isInteger(media?.size) ? media!.size as number : null
    }, { onConflict: "group_id,wa_message_id", ignoreDuplicates: true });
    if (inserted.error) return NextResponse.json({ error: "Could not save message" }, { status: 500 });
    counts.accepted += 1;
  }
  return NextResponse.json({ ok: true, ...counts });
}
