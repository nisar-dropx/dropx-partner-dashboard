import { reportBotWorkspace } from "@/lib/report-bot/workspace";
import { NextResponse } from "next/server";
import { reportBotApiAuthorization } from "@/lib/report-bot/access";
import { loadReportBotSettings, reportBotDb } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError, type WorkerGroup } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";

/** Every WhatsApp group the linked number belongs to, marked if the bot is on it. Feeds the group picker. */
export async function GET(request: Request) {
  const rawWorkspace = new URL(request.url).searchParams.get("workspace");
  if (rawWorkspace && !["last_mile", "dark_store"].includes(rawWorkspace)) return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  const workspace = reportBotWorkspace(rawWorkspace);
  const authorization = await reportBotApiAuthorization("edit", workspace);
  if (!authorization || !authorization.hasAllLocationAccess) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  const settings = await loadReportBotSettings(authorization.companyId!);
  try {
    const payload = await workerRequest<{ groups: WorkerGroup[] }>(settings, "/groups", { timeoutMs: 30000 });
    const enabled = await reportBotDb().from("report_bot_groups").select("wa_group_id,workspace,is_enabled").eq("company_id", settings.company_id);
    if (enabled.error) throw new Error("Cannot check group ownership.");
    const reserved = new Set((enabled.data ?? []).filter(row => row.workspace !== workspace).map(row => row.wa_group_id));
    const on = new Set((enabled.data ?? []).filter(row => row.workspace === workspace && row.is_enabled).map((row) => row.wa_group_id));
    const groups = (payload?.groups ?? [])
      .filter((group) => !reserved.has(group.id))
      .filter((group) => /^[0-9-]+@g\.us$/.test(group.id))
      .map((group) => ({ id: group.id, subject: group.subject || "Unnamed group", size: group.size, announce: group.announce, selected: on.has(group.id) }))
      .sort((a, b) => Number(b.selected) - Number(a.selected) || a.subject.localeCompare(b.subject));
    return NextResponse.json({ groups }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof WorkerError ? error.message : "Could not load groups from WhatsApp.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
