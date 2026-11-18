import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // location_id → { waGroupId, groupName }
  const groupByLocation = new Map(
    groups
      .filter((g) => stationRows.some((s) => s.id === g.location_id))
      .map((g) => [g.location_id as string, { waGroupId: g.wa_group_id as string, groupName: g.group_name as string }])
  );

  // --- 3. Load today's roster entries for dark store locations ---
  // hr_roster_entries.location_id matches stations.id (dark store station UUIDs).
  // Workers are assigned TO the dark store via the roster — their own employee/contractor
  // location_id is their home hub and must NOT be used as a filter here.
  const { data: rosterEntries, error: rosterErr } = await admin
    .from("hr_roster_entries")
    .select("worker_id,worker_type,day_type,location_id,hr_shifts(id,name,start_time,end_time),hr_roster_plans!inner(status,roster_kind)")
    .eq("company_id", companyId)
    .eq("roster_date", today)
    .in("location_id", locationIds)
    .eq("hr_roster_plans.status", "approved")
    .limit(5000);
  if (rosterErr) return NextResponse.json({ error: rosterErr.message }, { status: 500 });

  const workingEntries = (rosterEntries ?? []).filter((e) => e.day_type === "working");
  if (!workingEntries.length) return NextResponse.json({ ok: true, sent: 0, reason: "no working roster entries today" });

  // Collect ALL unique worker_ids regardless of worker_type tag —
  // query both tables with the full set so a mis-tagged roster entry
  // doesn't silently drop someone from the alert.
  const allWorkerIds = [...new Set(workingEntries.map((e) => e.worker_id))];

  // --- 4. Fetch worker details (name + biometric_id) from both tables ---
  const [empResult, ctrResult] = await Promise.all([
    allWorkerIds.length
      ? admin.from("employees")
          .select("id,employee_code,full_name,biometric_id")
          .eq("company_id", companyId)
          .in("id", allWorkerIds)
          .limit(5000)
      : Promise.resolve({ data: [], error: null }),
    allWorkerIds.length
      ? admin.from("contractors")
          .select("id,dropx_id,full_name,biometric_id")
          .eq("company_id", companyId)
          .in("id", allWorkerIds)
          .limit(5000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (empResult.error) return NextResponse.json({ error: empResult.error.message }, { status: 500 });
  if (ctrResult.error) return NextResponse.json({ error: ctrResult.error.message }, { status: 500 });

  type Person = { id: string; code: string; name: string; biometricId: string | null };
  const personById = new Map<string, Person>([
    ...(empResult.data ?? []).map((e): [string, Person] => [e.id, { id: e.id, code: e.employee_code ?? "—", name: e.full_name, biometricId: e.biometric_id }]),
    ...(ctrResult.data ?? []).map((c): [string, Person] => [c.id, { id: c.id, code: c.dropx_id ?? "—", name: c.full_name, biometricId: c.biometric_id }]),
  ]);

  // --- 5. Load today's attendance punches ---
  function biometricVariants(value: string | null | undefined): string[] {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const normalized = raw.replace(/^0+(?=\d)/, "") || "0";
    return [...new Set([raw, normalized, normalized.padStart(6, "0"), normalized.padStart(8, "0")])];
  }

  const allBiometricIds = [...new Set([...personById.values()].flatMap((p) => biometricVariants(p.biometricId)))];
  const punchResult = allBiometricIds.length
    ? await admin.from("attendance_punches")
        .select("enrolment_id,punch_time,punch_label")
        .eq("company_id", companyId)
        .eq("punch_date", today)
        .eq("calculated", true)
        .in("enrolment_id", allBiometricIds)
        .order("punch_time", { ascending: true })
        .limit(5000)
    : { data: [], error: null };
  if (punchResult.error) return NextResponse.json({ error: punchResult.error.message }, { status: 500 });

  const punchedEnrolments = new Set<string>();
  for (const punch of punchResult.data ?? []) {
    const label = (punch.punch_label ?? "").toLowerCase();
    if (!label || label.includes("in")) {
      punchedEnrolments.add(String(punch.enrolment_id).replace(/^0+(?=\d)/, "") || "0");
    }
  }

  function hasPunch(biometricId: string | null | undefined): boolean {
    for (const v of biometricVariants(biometricId)) {
      const key = v.replace(/^0+(?=\d)/, "") || "0";
      if (punchedEnrolments.has(key)) return true;
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
    shiftMap.get(shiftKey)!.people.push(person);
  }

  // --- 7. For each location → shift, check if alert is due and send ---
  const settings = await loadReportBotSettings(companyId);

  let sent = 0;
  const results: string[] = [];

  for (const [locationId, shiftMap] of shiftsByLocation) {
    const group = groupByLocation.get(locationId);
    if (!group) continue;

    for (const [shiftKey, { startTime, people }] of shiftMap) {
      const shiftStartMin = shiftTimeToMinutes(startTime);
      if (shiftStartMin === null) continue;

      const alertDueAt = shiftStartMin + 15;
      // Midnight wrap: a late shift (e.g. 23:30) has alertDueAt >= 1440.
      // After midnight the cron's nowMinutes resets to 0–59, so we add 1440
      // to bring it back into the same number line as the late-shift window.
      const effectiveNow = alertDueAt >= 1440 && nowMinutes < 120 ? nowMinutes + 1440 : nowMinutes;
      // Only fire within a 15-min window (cron runs every 15 min, fires once per shift)
      if (effectiveNow < alertDueAt || effectiveNow >= alertDueAt + 15) continue;

      const notReported = people.filter((p) => !hasPunch(p.biometricId));
      const reported = people.length - notReported.length;

      if (notReported.length === 0) {
        results.push(`${group.groupName} ${shiftKey}: all ${people.length} reported`);
        continue;
      }

      const shiftLabel = minutesToHHMM(shiftStartMin);
      const lines = [
        `In the ${shiftLabel} hrs shift, only ${reported} of ${people.length} people scheduled reported by ${minutesToHHMM(alertDueAt)} hrs. Why? Below are the people who have not reported:`,
        ...notReported.map((p) => `- ${p.name} (${p.code})`),
      ];
      const text = lines.join("\n");

      try {
        await workerRequest<{ id: string }>(settings, "/send", {
          method: "POST",
          body: {
            to: group.waGroupId,
            text,
            client_ref: `shift-noshow-${locationId}-${today}-${shiftKey.replace(":", "")}`,
          },
        });
        sent++;
        results.push(`${group.groupName} ${shiftKey}: ${notReported.length} not reported — sent`);
      } catch (err) {
        const msg = err instanceof WorkerError ? err.message : String(err);
        results.push(`${group.groupName} ${shiftKey}: send failed — ${msg}`);
      }
    }
  }

  return NextResponse.json({ ok: true, sent, today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, results });
}
