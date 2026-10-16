import { NextResponse } from "next/server";
import { reportBotDb, settingsForWorkerRequest } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";

/** What the worker may listen to and send to. Nothing when the bot is off. */
export async function GET(request: Request) {
  let settings;
  try {
    settings = await settingsForWorkerRequest(request);
  } catch {
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
  if (!settings) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = reportBotDb();
  await db.from("report_bot_settings").update({ last_worker_seen_at: new Date().toISOString() }).eq("company_id", settings.company_id);
  if (settings.mode === "off") return NextResponse.json({ mode: "off", groups: [], include_own_messages: false });
  const groups = await db.from("report_bot_groups").select("wa_group_id").eq("company_id", settings.company_id).eq("is_enabled", true);
  if (groups.error) return NextResponse.json({ error: "Could not load groups" }, { status: 500 });
  return NextResponse.json({
    mode: settings.mode,
    groups: (groups.data ?? []).map((group) => group.wa_group_id),
    include_own_messages: settings.include_own_messages
  });
}
