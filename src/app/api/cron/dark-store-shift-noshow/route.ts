import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";
import { biometricEnrolmentIdCandidates, normalizeBiometricEnrolmentId } from "@/lib/biometric/enrolment-resolution";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// IST = UTC+5:30
const IST_OFFSET_MINUTES = 330;

function nowInIst() {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MINUTES * 60000);
}

function isoDateInIst(d = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.toISOString().slice(0, 10);
}

/** Parse "HH:MM:SS" or "HH:MM" shift time → minutes since midnight */
function shiftTimeToMinutes(value: string | null | undefined): number | null {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Format minutes-since-midnight → "HH:MM" */
function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  // ?test=1   — bypasses time window, sends to Dark Store Testing group
  // ?force=1  — bypasses time window, sends to REAL war room groups (use carefully)
  // ?shift=HH:MM — only process this shift start time
  const testMode = url.searchParams.get("test") === "1";
  const forceMode = url.searchParams.get("force") === "1";
  const shiftFilter = url.searchParams.get("shift") ?? null; // e.g. "15:00"
  const testingGroupJid = "120363429732355530@g.us";
  if (!supabaseAdmin)
    return NextResponse.json({ error: "Supabase service role key not configured." }, { status: 500 });

  const admin = supabaseAdmin;
  const today = isoDateInIst();
  const istNow = nowInIst();
  const nowMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes(); // minutes since midnight IST

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

  const locationIds = groups.map((g) => g.location_id as string);

  // --- 2. Find company_id from stations table ---
  const { data: stationRows, error: locErr } = await admin
    .from("stations")
    .select("id,company_id,station_code")
    .in("id", locationIds)
    .limit(50);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
  if (!stationRows?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no stations found" });

  const companyId = stationRows[0].company_id as string;

  // location_id → { waGroupId, groupName } — skip groups with no WA group ID
  const groupByLocation = new Map(
    groups
      .filter((g) => stationRows.some((s) => s.id === g.location_id) && g.wa_group_id)
      .map((g) => [g.location_id as string, { waGroupId: g.wa_group_id as string, groupName: (g.group_name as string | null) ?? g.location_id as string }])
  );

  // --- 3. Load approved roster plans covering today at dark store locations ---
  // hr_roster_plans covers a week (period_start..period_end), not a single date.
  // Fetch plans where today falls within the period, then filter entries by plan_id
  // to avoid PostgREST !inner join ambiguity on hr_roster_entries.
  const { data: approvedPlans, error: plansErr } = await admin
    .from("hr_roster_plans")
    .select("id")
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .eq("status", "approved")
    .lte("period_start", today)
    .or(`period_end.is.null,period_end.gte.${today}`);
  if (plansErr) return NextResponse.json({ error: plansErr.message }, { status: 500 });

  const approvedPlanIds = (approvedPlans ?? []).map((p) => p.id as string);
  if (!approvedPlanIds.length) return NextResponse.json({ ok: true, sent: 0, reason: "no approved roster plans covering today", today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, locationIds });

  const { data: rosterEntries, error: rosterErr } = await admin
    .from("hr_roster_entries")
    .select("worker_id,worker_type,day_type,location_id,plan_id,hr_shifts(id,name,start_time,end_time)")
    .eq("company_id", companyId)
    .eq("roster_date", today)
    .in("location_id", locationIds)
    .in("plan_id", approvedPlanIds)
    .limit(5000);
  if (rosterErr) return NextResponse.json({ error: rosterErr.message }, { status: 500 });

  const workingEntries = (rosterEntries ?? []).filter((e) => e.day_type === "working");
  if (!workingEntries.length) return NextResponse.json({ ok: true, sent: 0, reason: "no working roster entries today", today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, totalEntries: rosterEntries?.length ?? 0, approvedPlanIds });
  if ((rosterEntries?.length ?? 0) >= 5000) console.warn(`[shift-noshow] roster entry limit hit (5000) — some entries may be missing`);

  // Collect ALL unique worker_ids regardless of worker_type tag —
  // query both tables with the full set so a mis-tagged roster entry
  // doesn't silently drop someone from the alert.
  const allWorkerIds = [...new Set(workingEntries.map((e) => e.worker_id))];

  // --- 4. Fetch worker details (name + biometric_id) from both tables ---
  // Chunk worker IDs to avoid PostgREST URL length limits on large .in() lists
  const WORKER_CHUNK = 150;
  const workerChunks: string[][] = [];
  for (let i = 0; i < allWorkerIds.length; i += WORKER_CHUNK) workerChunks.push(allWorkerIds.slice(i, i + WORKER_CHUNK));

  const [empChunkResults, ctrChunkResults] = await Promise.all([
    allWorkerIds.length
      ? Promise.all(workerChunks.map((chunk) =>
          admin.from("employees")
            .select("id,employee_code,full_name,biometric_id,last_working_date,people_lifecycle_status")
            .eq("company_id", companyId)
            .in("id", chunk)
            .limit(5000)
        ))
      : Promise.resolve([{ data: [], error: null }]),
    allWorkerIds.length
      ? Promise.all(workerChunks.map((chunk) =>
          admin.from("contractors")
            .select("id,dropx_id,full_name,biometric_id,last_working_date,lifecycle_status")
            .eq("company_id", companyId)
            .in("id", chunk)
            .limit(5000)
        ))
      : Promise.resolve([{ data: [], error: null }]),
  ]);
  const empError = empChunkResults.find((r) => r.error)?.error;
  const ctrError = ctrChunkResults.find((r) => r.error)?.error;
  if (empError) return NextResponse.json({ error: empError.message }, { status: 500 });
  if (ctrError) return NextResponse.json({ error: ctrError.message }, { status: 500 });
  const empData = empChunkResults.flatMap((r) => r.data ?? []);
  const ctrData = ctrChunkResults.flatMap((r) => r.data ?? []);

  const offboardedStatuses = new Set(["offboarding", "offboarded"]);

  type Person = { id: string; code: string; name: string; biometricId: string | null };
  const personById = new Map<string, Person>([
    ...empData
      .filter((e) => {
        if (offboardedStatuses.has(e.people_lifecycle_status ?? "")) return false;
        if (e.last_working_date && e.last_working_date < today) return false;
        return true;
      })
      .map((e): [string, Person] => [e.id, { id: e.id, code: e.employee_code ?? "—", name: e.full_name ?? "Unknown", biometricId: e.biometric_id }]),
    ...ctrData
      .filter((c) => {
        if (offboardedStatuses.has(c.lifecycle_status ?? "")) return false;
        if (c.last_working_date && c.last_working_date < today) return false;
        return true;
      })
      .map((c): [string, Person] => [c.id, { id: c.id, code: c.dropx_id ?? "—", name: c.full_name ?? "Unknown", biometricId: c.biometric_id }]),
  ]);

  // --- 5. Load today's attendance punches ---
  // Use the same candidate generation as the attendance page (up to 20 zero-padded variants)
  const allBiometricIds = [...new Set([...personById.values()].flatMap((p) => biometricEnrolmentIdCandidates(p.biometricId)))];
  // Chunk to avoid PostgREST URL length limits on large .in() lists
  const BIO_CHUNK = 150;
  const bioChunks: string[][] = [];
  for (let i = 0; i < allBiometricIds.length; i += BIO_CHUNK) bioChunks.push(allBiometricIds.slice(i, i + BIO_CHUNK));
  // Do NOT filter by calculated — real-time punches may not be calculated yet
  // when the alert fires 15 min after shift start.
  const punchChunkResults = allBiometricIds.length
    ? await Promise.all(bioChunks.map((chunk) =>
        admin.from("attendance_punches")
          .select("enrolment_id,punch_time,punch_label")
          .eq("company_id", companyId)
          .eq("punch_date", today)
          .in("enrolment_id", chunk)
          .order("punch_time", { ascending: true })
          .limit(5000)
      ))
    : [];
  const punchError = punchChunkResults.find((r) => r.error)?.error;
  if (punchError) return NextResponse.json({ error: punchError.message }, { status: 500 });
  const punchData = punchChunkResults.flatMap((r) => r.data ?? []);

  // normalized enrolment_id → sorted list of check-in punch times (minutes since midnight IST)
  const punchTimesByEnrolment = new Map<string, number[]>();
  for (const punch of punchData) {
    const label = (punch.punch_label ?? "").toLowerCase().trim();
    const isIn = !label || label.startsWith("in") || label === "i" || label.startsWith("check-in")
      || label.startsWith("checkin") || label === "entry" || label === "check in";
    if (!isIn) continue;
    // punch_time is an ISO timestamp; convert to minutes-since-midnight IST
    const pt = new Date(punch.punch_time);
    const ptIst = new Date(pt.getTime() + IST_OFFSET_MINUTES * 60000);
    const ptMin = ptIst.getUTCHours() * 60 + ptIst.getUTCMinutes();
    const key = normalizeBiometricEnrolmentId(punch.enrolment_id);
    const list = punchTimesByEnrolment.get(key) ?? [];
    list.push(ptMin);
    punchTimesByEnrolment.set(key, list);
  }

  // Returns true if the person has a check-in punch within [shiftStart - 120min, max(shiftStart + 15, nowMinutes)]
  // windowEnd extends to nowMinutes so a punch that arrives just before the cron fires is captured.
  function hasPunchForShift(biometricId: string | null | undefined, shiftStartMin: number): boolean {
    const windowStart = shiftStartMin - 120;
    const windowEnd = Math.max(shiftStartMin + 15, nowMinutes);
    for (const v of biometricEnrolmentIdCandidates(biometricId)) {
      const times = punchTimesByEnrolment.get(normalizeBiometricEnrolmentId(v));
      if (times?.some((t) => t >= windowStart && t <= windowEnd)) return true;
    }
    return false;
  }

  // --- 6. Build location → shift → people map from roster entries ---
  type ShiftGroup = { startTime: string; people: Person[] };
  const shiftsByLocation = new Map<string, Map<string, ShiftGroup>>();

  for (const entry of workingEntries) {
    const locationId = entry.location_id as string;
    if (!groupByLocation.has(locationId)) continue;

    const shift = Array.isArray(entry.hr_shifts) ? entry.hr_shifts[0] : entry.hr_shifts;
    if (!shift?.start_time) continue;

    const person = personById.get(entry.worker_id);
    if (!person) continue;

    const shiftKey = shift.start_time.slice(0, 5); // "HH:MM"
    if (!shiftsByLocation.has(locationId)) shiftsByLocation.set(locationId, new Map());
    const shiftMap = shiftsByLocation.get(locationId)!;
    if (!shiftMap.has(shiftKey)) shiftMap.set(shiftKey, { startTime: shift.start_time, people: [] });
    const shiftPeople = shiftMap.get(shiftKey)!.people;
    // Deduplicate: a worker can appear multiple times if they have overlapping roster entries
    if (!shiftPeople.some((p) => p.id === person.id)) shiftPeople.push(person);
  }

  // --- 7. For each location → shift, check if alert is due and send ---
  const settings = await loadReportBotSettings(companyId);

  let sent = 0;
  const results: string[] = [];
  const debugShifts: object[] = [];

  // Collect all send tasks and run in parallel to avoid timeout on many stations
  const sendTasks: Promise<void>[] = [];

  for (const [locationId, shiftMap] of shiftsByLocation) {
    const group = groupByLocation.get(locationId);
    if (!group) continue;

    for (const [shiftKey, { startTime, people }] of shiftMap) {
      const shiftStartMin = shiftTimeToMinutes(startTime);
      if (shiftStartMin === null) continue;

      // ?shift=HH:MM — only process this exact shift start
      if (shiftFilter && shiftKey !== shiftFilter) continue;

      const alertDueAt = shiftStartMin + 15;
      // Midnight wrap: late shifts (e.g. 23:30 → alertDueAt=1425) fire after midnight;
      // after midnight nowMinutes resets to 0–59 so add 1440 to stay on the same number line.
      const effectiveNow = alertDueAt >= 1440 && nowMinutes < 120 ? nowMinutes + 1440 : nowMinutes;
      const inWindow = effectiveNow >= alertDueAt && effectiveNow < alertDueAt + 15;
      const notReported = people.filter((p) => !hasPunchForShift(p.biometricId, shiftStartMin));

      if (debug) {
        debugShifts.push({
          station: group.groupName,
          shift: shiftKey,
          alertDueAt: minutesToHHMM(alertDueAt),
          effectiveNow: minutesToHHMM(effectiveNow),
          inWindow,
          total: people.length,
          notReported: notReported.length,
          people: people.map((p) => ({
            name: p.name,
            code: p.code,
            biometricId: p.biometricId,
            biometricVariants: biometricEnrolmentIdCandidates(p.biometricId),
            hasPunch: hasPunchForShift(p.biometricId, shiftStartMin),
            punches: punchData
              .filter((punch) => biometricEnrolmentIdCandidates(p.biometricId).includes(normalizeBiometricEnrolmentId(punch.enrolment_id)))
              .map((punch) => ({ enrolment_id: punch.enrolment_id, punch_time: punch.punch_time, punch_label: punch.punch_label })),
          })),
        });
      }

      if (!inWindow && !testMode && !forceMode) continue;
      if (notReported.length === 0) {
        results.push(`${group.groupName} ${shiftKey}: all ${people.length} reported`);
        continue;
      }

      const reported = people.length - notReported.length;
      const shiftLabel = minutesToHHMM(shiftStartMin);
      const intro = reported === 0
        ? `In the ${shiftLabel} hrs shift, none of the ${people.length} people scheduled have reported by ${minutesToHHMM(alertDueAt)} hrs. Why? Below are the people who have not reported:`
        : `In the ${shiftLabel} hrs shift, only ${reported} of ${people.length} people scheduled reported by ${minutesToHHMM(alertDueAt)} hrs. Why? Below are the people who have not reported:`;
      const lines = [intro, ...notReported.map((p) => `- ${p.name} (${p.code})`)];
      const text = lines.join("\n");
      // client_ref: must match /^[A-Za-z0-9_-]{8,64}$/
      // UUID location_id + date + shift would exceed 64 chars, so use last 8 chars of UUID
      const locShort = locationId.replace(/-/g, "").slice(-8);
      const dateShort = today.replace(/-/g, "").slice(2); // "261120"
      const clientRef = `ssn-${locShort}-${dateShort}-${shiftKey.replace(":", "")}${testMode ? "-t" : forceMode ? "-f" : ""}`;
      const toGroup = testMode ? testingGroupJid : group.waGroupId;
      const label = `${group.groupName} ${shiftKey}`;

      sendTasks.push(
        workerRequest<{ id: string }>(settings, "/send", {
          method: "POST",
          body: { to: toGroup, text, client_ref: clientRef },
        })
          .then(() => { sent++; results.push(`${label}: ${notReported.length} not reported — sent`); })
          .catch((err) => {
            const msg = err instanceof WorkerError ? err.message : String(err);
            results.push(`${label}: send failed — ${msg}`);
          })
      );
    }
  }

  await Promise.all(sendTasks);

  return NextResponse.json({ ok: true, sent, today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, results, ...(debug ? { debugShifts } : {}) });
}
