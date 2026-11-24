import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// IST = UTC+5:30
const IST_OFFSET_MINUTES = 330;

/** Groups that must never receive automated Dark Store ops WhatsApp. */
const MUTED_GROUP_NAME = /^(?:tfb7(?:\s*:\s*war\s*room)?|dark\s*store\s*testing|testing)$/i;

function nowInIst() {
  return new Date(Date.now() + IST_OFFSET_MINUTES * 60000);
}

function isoDateInIst(d = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.toISOString().slice(0, 10);
}

function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isMutedGroup(name: string | null | undefined) {
  return MUTED_GROUP_NAME.test(String(name ?? "").trim());
}

// Fires at 08:00 IST — checks yesterday's Store Operations checklist (not SI shifts).
const ALERT_HOUR_MINUTES = 8 * 60; // 08:00
const ALERT_WINDOW_MINUTES = 15;   // once in the first quarter-hour only

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!supabaseAdmin)
    return NextResponse.json({ error: "Supabase service role key not configured." }, { status: 500 });

  const url = new URL(request.url);
  // ?test=1  — sends to Dark Store Testing group instead of real war rooms
  // ?force=1 — bypasses time window, sends to real groups
  const testMode = url.searchParams.get("test") === "1";
  const forceMode = url.searchParams.get("force") === "1";
  const testingGroupJid = "120363429732355530@g.us";

  const admin = supabaseAdmin;
  const istNow = nowInIst();
  const nowMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const inWindow = nowMinutes >= ALERT_HOUR_MINUTES && nowMinutes < ALERT_HOUR_MINUTES + ALERT_WINDOW_MINUTES;

  if (!inWindow && !testMode && !forceMode) {
    return NextResponse.json({ ok: true, sent: 0, reason: "not in window", nowMinutes: `${minutesToHHMM(nowMinutes)} IST` });
  }

  const yesterday = isoDateInIst(new Date(Date.now() - 24 * 3600 * 1000));

  const botDb = reportBotDb();
  if (!botDb) return NextResponse.json({ error: "Report bot DB not configured." }, { status: 500 });

  const { data: groups, error: groupsErr } = await botDb
    .from("report_bot_groups")
    .select("id,wa_group_id,group_name,location_id")
    .eq("workspace", "dark_store")
    .eq("is_enabled", true)
    .not("location_id", "is", null);
  if (groupsErr) return NextResponse.json({ error: groupsErr.message }, { status: 500 });
  if (!groups?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no dark_store groups" });

  const activeGroups = groups.filter((g) => g.wa_group_id && !isMutedGroup(g.group_name as string | null));
  const locationIds = activeGroups.map((g) => g.location_id as string);

  const groupByLocation = new Map(
    activeGroups.map((g) => [
      g.location_id as string,
      { waGroupId: g.wa_group_id as string, groupName: (g.group_name as string | null) ?? (g.location_id as string) }
    ])
  );

  if (!locationIds.length) return NextResponse.json({ ok: true, sent: 0, reason: "no groups with location_id and wa_group_id" });

  const { data: stationRows, error: stErr } = await admin
    .from("stations")
    .select("id,company_id")
    .in("id", locationIds)
    .limit(1);
  if (stErr) return NextResponse.json({ error: stErr.message }, { status: 500 });
  if (!stationRows?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no stations found" });
  const companyId = stationRows[0].company_id as string;

  // Store Operations = one checklist per store per work_date. Submitted (or cancelled) counts as done.
  const { data: checklists, error: clErr } = await admin
    .from("ops_store_ops_checklists")
    .select("location_id,status")
    .eq("company_id", companyId)
    .eq("work_date", yesterday)
    .in("location_id", locationIds);
  if (clErr) return NextResponse.json({ error: clErr.message }, { status: 500 });

  const statusByLocation = new Map<string, string>();
  for (const row of checklists ?? []) {
    statusByLocation.set(row.location_id as string, String(row.status ?? ""));
  }

  const settings = await loadReportBotSettings(companyId);

  let sent = 0;
  const results: string[] = [];
  const sendTasks: Promise<void>[] = [];
  const sentToGroup = new Set<string>();

  for (const locationId of locationIds) {
    const group = groupByLocation.get(locationId);
    if (!group) continue;

    const toGroupCheck = testMode ? testingGroupJid : group.waGroupId;
    if (sentToGroup.has(toGroupCheck)) {
      results.push(`${group.groupName}: skipped (same group already queued)`);
      continue;
    }

    const status = statusByLocation.get(locationId);
    // Only submitted counts as complete — open / cancelled / other still alert.
    if (status === "submitted") {
      results.push(`${group.groupName}: store operations submitted`);
      continue;
    }

    const dateShort = yesterday.replace(/-/g, "").slice(2);
    const testSuffix = testMode ? `-t${Math.floor(Date.now() / 60000) % 10000}` : forceMode ? "-f" : "";
    const toGroup = toGroupCheck;
    const groupShort = toGroup.replace(/[^a-z0-9]/gi, "").slice(-8);
    const clientRef = `dsoi-${groupShort}-${dateShort}${testSuffix}`;
    sentToGroup.add(toGroup);
    const reason = !status ? "not started" : status === "open" ? "started but not submitted" : `status ${status}`;
    const text = `Store operations in Ops Pulse for yesterday not completed. Why?`;
    const label = `${group.groupName}`;

    sendTasks.push(
      workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: { to: toGroup, text, client_ref: clientRef },
        timeoutMs: 45_000
      })
        .then(() => { sent++; results.push(`${label}: ${reason} — sent`); })
        .catch((err) => {
          const msg = err instanceof WorkerError ? err.message : String(err);
          results.push(`${label}: send failed — ${msg}`);
        })
    );
  }

  await Promise.all(sendTasks);

  return NextResponse.json({ ok: true, sent, yesterday, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, results });
}
