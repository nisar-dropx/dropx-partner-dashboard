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

// SI checklist shift slots and their alert windows (2 hrs after shift start).
// Alert fires in the 15-min window starting 2 hrs after shift start, once per hour.
const SHIFT_SLOTS: { slot: string; alertAfterMinutes: number }[] = [
  { slot: "06:00", alertAfterMinutes: 6 * 60 + 120 },  // alert at 08:00
  { slot: "14:00", alertAfterMinutes: 14 * 60 + 120 }, // alert at 16:00
  { slot: "22:00", alertAfterMinutes: 22 * 60 + 120 }, // alert at 00:00 next day
];

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!supabaseAdmin)
    return NextResponse.json({ error: "Supabase service role key not configured." }, { status: 500 });

  const url = new URL(request.url);
  // ?test=1  — sends to Dark Store Testing group instead of real war rooms
  // ?force=1 — bypasses time window, sends to real groups
  // ?slot=HH:MM — only process this shift slot
  const testMode = url.searchParams.get("test") === "1";
  const forceMode = url.searchParams.get("force") === "1";
  const slotFilter = url.searchParams.get("slot") ?? null;
  const testingGroupJid = "120363429732355530@g.us";

  const admin = supabaseAdmin;
  const istNow = nowInIst();
  const nowMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const today = isoDateInIst();
  // For the 22:00 shift (alerts at 00:00 next day), we need yesterday's date
  const yesterday = isoDateInIst(new Date(Date.now() - 24 * 3600 * 1000));

  // --- 1. Load dark_store War Room groups + their location_ids ---
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

  // --- 3. Load report-bot settings for worker client ---
  const settings = await loadReportBotSettings(companyId);

  // --- 4. Determine which slots are due right now ---
  type SlotDue = { slot: string; shiftDate: string };
  const slotsDue: SlotDue[] = [];

  for (const { slot, alertAfterMinutes } of SHIFT_SLOTS) {
    if (slotFilter && slot !== slotFilter) continue;

    // 22:00 shift alerts at 00:00 next day — nowMinutes 0–14 maps to 1440–1454
    const isOvernightAlert = alertAfterMinutes >= 1440;
    const effectiveNow = isOvernightAlert && nowMinutes < 60 ? nowMinutes + 1440 : nowMinutes;
    const inWindow = effectiveNow >= alertAfterMinutes && effectiveNow < alertAfterMinutes + 60;

    if (!inWindow && !testMode && !forceMode) continue;

    // For the overnight 22:00 slot alerting at 00:00+, the checklist shift_date is yesterday
    const shiftDate = isOvernightAlert && nowMinutes < 60 ? yesterday : today;
    slotsDue.push({ slot, shiftDate });
  }

  if (!slotsDue.length) {
    return NextResponse.json({ ok: true, sent: 0, reason: "no slots due now", nowMinutes: `${minutesToHHMM(nowMinutes)} IST` });
  }

  // --- 5. For each due slot, fetch existing checklists ---
  let sent = 0;
  const results: string[] = [];
  const sendTasks: Promise<void>[] = [];

  for (const { slot, shiftDate } of slotsDue) {
    const { data: checklists, error: clErr } = await admin
      .from("ops_si_shift_checklists")
      .select("location_id,status")
      .eq("company_id", companyId)
      .eq("shift_date", shiftDate)
      .eq("shift_slot", slot)
      .in("location_id", locationIds)
      .is("deleted_at", null);
    if (clErr) { results.push(`slot ${slot}: DB error — ${clErr.message}`); continue; }

    // Locations that have a checklist (started, any status)
    const startedLocations = new Set((checklists ?? []).map((c) => c.location_id as string));

    for (const locationId of locationIds) {
      const group = groupByLocation.get(locationId);
      if (!group) continue;

      if (startedLocations.has(locationId)) {
        results.push(`${group.groupName} ${slot}: started`);
        continue;
      }

      const locShort = locationId.replace(/-/g, "").slice(-8);
      const dateShort = shiftDate.replace(/-/g, "").slice(2);
      const testSuffix = testMode ? `-t${Math.floor(Date.now() / 60000) % 10000}` : forceMode ? "-f" : "";
      const clientRef = `ssns-${locShort}-${dateShort}-${slot.replace(":", "")}${testSuffix}`;
      const toGroup = testMode ? testingGroupJid : group.waGroupId;
      const text = `Shift operations in Ops Pulse for ${slot} hrs shift not yet started. Why?`;
      const label = `${group.groupName} ${slot}`;

      sendTasks.push(
        workerRequest<{ id: string }>(settings, "/send", {
          method: "POST",
          body: { to: toGroup, text, client_ref: clientRef },
        })
          .then(() => { sent++; results.push(`${label}: not started — sent`); })
          .catch((err) => {
            const msg = err instanceof WorkerError ? err.message : String(err);
            results.push(`${label}: send failed — ${msg}`);
          })
      );
    }
  }

  await Promise.all(sendTasks);

  return NextResponse.json({ ok: true, sent, today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, slotsDue, results });
}
