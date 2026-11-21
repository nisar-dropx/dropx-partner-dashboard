import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// IST = UTC+5:30
const IST_OFFSET_MINUTES = 330;

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

// Fires at 08:00 IST — checks yesterday's checklists for any slot not accepted.
const ALERT_HOUR_MINUTES = 8 * 60; // 08:00
const ALERT_WINDOW_MINUTES = 60;   // fire within 60-min window

const ALL_SLOTS = ["06:00", "14:00", "22:00"];

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

  // --- 1. Load dark_store War Room groups ---
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

  const locationIds = groups
    .filter((g) => g.wa_group_id)
    .map((g) => g.location_id as string);

  const groupByLocation = new Map(
    groups
      .filter((g) => g.wa_group_id)
      .map((g) => [g.location_id as string, { waGroupId: g.wa_group_id as string, groupName: (g.group_name as string | null) ?? (g.location_id as string) }])
  );

  if (!locationIds.length) return NextResponse.json({ ok: true, sent: 0, reason: "no groups with location_id and wa_group_id" });

  // --- 2. Find company_id ---
  const { data: stationRows, error: stErr } = await admin
    .from("stations")
    .select("id,company_id")
    .in("id", locationIds)
    .limit(1);
  if (stErr) return NextResponse.json({ error: stErr.message }, { status: 500 });
  if (!stationRows?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no stations found" });
  const companyId = stationRows[0].company_id as string;

  // --- 3. Load yesterday's checklists for all dark store locations ---
  const { data: checklists, error: clErr } = await admin
    .from("ops_si_shift_checklists")
    .select("location_id,shift_slot,status")
    .eq("company_id", companyId)
    .eq("shift_date", yesterday)
    .in("location_id", locationIds)
    .is("deleted_at", null);
  if (clErr) return NextResponse.json({ error: clErr.message }, { status: 500 });

  // Map: locationId → slot → status
  const statusMap = new Map<string, Map<string, string>>();
  for (const c of checklists ?? []) {
    const locId = c.location_id as string;
    if (!statusMap.has(locId)) statusMap.set(locId, new Map());
    statusMap.get(locId)!.set(c.shift_slot as string, c.status as string);
  }

  // --- 4. Load report-bot settings ---
  const settings = await loadReportBotSettings(companyId);

  let sent = 0;
  const results: string[] = [];
  const sendTasks: Promise<void>[] = [];

  for (const locationId of locationIds) {
    const group = groupByLocation.get(locationId);
    if (!group) continue;

    const slotStatuses = statusMap.get(locationId) ?? new Map<string, string>();
    // Find slots that are missing or not accepted
    const incompleteSlots: string[] = [];
    for (const slot of ALL_SLOTS) {
      const status = slotStatuses.get(slot);
      if (!status) {
        incompleteSlots.push(`${slot} (not started)`);
      } else if (status !== "accepted") {
        incompleteSlots.push(`${slot} (${status})`);
      }
    }

    if (!incompleteSlots.length) {
      results.push(`${group.groupName}: all 3 shifts accepted`);
      continue;
    }

    const locShort = locationId.replace(/-/g, "").slice(-8);
    const dateShort = yesterday.replace(/-/g, "").slice(2);
    const clientRef = `dsoi-${locShort}-${dateShort}${testMode ? "-t" : forceMode ? "-f" : ""}`;
    const toGroup = testMode ? testingGroupJid : group.waGroupId;
    const text = `Store operations in Ops Pulse for yesterday not completed. Why?\n(Incomplete shifts: ${incompleteSlots.join(", ")})`;
    const label = `${group.groupName}`;

    sendTasks.push(
      workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: { to: toGroup, text, client_ref: clientRef },
      })
        .then(() => { sent++; results.push(`${label}: ${incompleteSlots.length} incomplete — sent`); })
        .catch((err) => {
          const msg = err instanceof WorkerError ? err.message : String(err);
          results.push(`${label}: send failed — ${msg}`);
        })
    );
  }

  await Promise.all(sendTasks);

  return NextResponse.json({ ok: true, sent, yesterday, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, results });
}
