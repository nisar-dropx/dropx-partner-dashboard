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

/** Parse "HH:MM" shift time → minutes since midnight */
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
    .eq("mode", "live")
    .not("location_id", "is", null);
  if (groupsErr) return NextResponse.json({ error: groupsErr.message }, { status: 500 });
  if (!groups?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no dark_store groups" });

  const locationIds = groups.map((g) => g.location_id as string);

  // --- 2. Find company_id + station_code from stations table ---
  const { data: stationRows, error: locErr } = await admin
    .from("stations")
    .select("id,company_id,station_code")
    .in("id", locationIds)
    .limit(50);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
  if (!stationRows?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no stations found" });

  const companyId = stationRows[0].company_id as string;
  const locationById = new Map(stationRows.map((s) => [s.id, s]));

  // location_id → wa_group_id + group_name
  const groupByLocation = new Map(
    groups
      .filter((g) => locationById.has(g.location_id as string))
      .map((g) => [g.location_id as string, { waGroupId: g.wa_group_id as string, groupName: g.group_name as string }])
  );

  // --- 3. Load all active people at these locations ---
  const [empResult, ctrResult] = await Promise.all([
    admin.from("employees")
      .select("id,employee_code,full_name,biometric_id,location_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .not("people_lifecycle_status", "in", '("offboarding","offboarded")')
      .is("deleted_at", null)
      .in("location_id", locationIds)
      .limit(5000),
    admin.from("contractors")
      .select("id,dropx_id,full_name,biometric_id,location_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .not("people_lifecycle_status", "in", '("offboarding","offboarded")')
      .is("deleted_at", null)
      .in("location_id", locationIds)
      .limit(5000),
  ]);
  if (empResult.error) return NextResponse.json({ error: empResult.error.message }, { status: 500 });
  if (ctrResult.error) return NextResponse.json({ error: ctrResult.error.message }, { status: 500 });

  type Person = { id: string; code: string; name: string; biometricId: string | null; locationId: string };
  const people: Person[] = [
    ...(empResult.data ?? []).map((e) => ({ id: e.id, code: e.employee_code ?? "—", name: e.full_name, biometricId: e.biometric_id, locationId: e.location_id as string })),
    ...(ctrResult.data ?? []).map((c) => ({ id: c.id, code: c.dropx_id ?? "—", name: c.full_name, biometricId: c.biometric_id, locationId: c.location_id as string })),
  ].filter((p) => locationIds.includes(p.locationId));

  if (!people.length) return NextResponse.json({ ok: true, sent: 0, reason: "no people at dark store locations" });

  const workerIds = people.map((p) => p.id);

  // --- 4. Load today's dated roster entries for these workers ---
  const { data: rosterEntries, error: rosterErr } = await admin
    .from("hr_roster_entries")
    .select("worker_id,worker_type,day_type,hr_shifts(id,name,start_time,end_time),hr_roster_plans!inner(status,roster_kind)")
    .eq("company_id", companyId)
    .eq("roster_date", today)
    .in("worker_id", workerIds)
    .eq("hr_roster_plans.status", "approved")
    .eq("hr_roster_plans.roster_kind", "dated")
    .limit(5000);
  if (rosterErr) return NextResponse.json({ error: rosterErr.message }, { status: 500 });

  // Build map: worker_id → shift { start_time, end_time, name }
  type ShiftInfo = { startTime: string; endTime: string; name: string };
  const shiftByWorker = new Map<string, ShiftInfo>();
  for (const entry of rosterEntries ?? []) {
    if (entry.day_type !== "working") continue;
    const shift = Array.isArray(entry.hr_shifts) ? entry.hr_shifts[0] : entry.hr_shifts;
    if (!shift?.start_time) continue;
    shiftByWorker.set(entry.worker_id, { startTime: shift.start_time, endTime: shift.end_time ?? "", name: shift.name ?? "" });
  }

  // --- 5. Load today's attendance punches (IN punches) ---
  function biometricVariants(value: string | null | undefined) {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const normalized = raw.replace(/^0+(?=\d)/, "") || "0";
    return [...new Set([raw, normalized, normalized.padStart(6, "0"), normalized.padStart(8, "0")])];
  }
  const enrolmentIds = [...new Set(people.flatMap((p) => biometricVariants(p.biometricId)))];
  const punchResult = enrolmentIds.length
    ? await admin.from("attendance_punches")
      .select("enrolment_id,punch_time,punch_label")
      .eq("company_id", companyId)
      .eq("punch_date", today)
      .eq("calculated", true)
      .in("enrolment_id", enrolmentIds)
      .order("punch_time", { ascending: true })
      .limit(5000)
    : { data: [], error: null };
  if (punchResult.error) return NextResponse.json({ error: punchResult.error.message }, { status: 500 });

  // Build set of enrolment_ids that have an IN punch
  const punchedEnrolments = new Set<string>();
  for (const punch of punchResult.data ?? []) {
    const label = (punch.punch_label ?? "").toLowerCase();
    if (!label || label.includes("in") || label === "") {
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

  // --- 6. Group people by location → shift window → check if alert is due ---
  // Dedup is handled entirely by client_ref at the worker level (same as dark-store-ppi).
  // The worker rejects duplicate client_refs, so each shift alert fires at most once.

  const settings = await loadReportBotSettings(companyId);
  if (!settings) return NextResponse.json({ ok: true, sent: 0, reason: "report bot not configured" });

  let sent = 0;
  const results: string[] = [];

  // Group people by location
  const peopleByLocation = new Map<string, Person[]>();
  for (const person of people) {
    if (!peopleByLocation.has(person.locationId)) peopleByLocation.set(person.locationId, []);
    peopleByLocation.get(person.locationId)!.push(person);
  }

  for (const [locationId, locationPeople] of peopleByLocation) {
    const group = groupByLocation.get(locationId);
    if (!group) continue;

    // Find unique shift windows at this location today
    const shiftWindows = new Map<string, Person[]>(); // "HH:MM" → people
    for (const person of locationPeople) {
      const shift = shiftByWorker.get(person.id);
      if (!shift) continue;
      const key = shift.startTime.slice(0, 5); // "HH:MM"
      if (!shiftWindows.has(key)) shiftWindows.set(key, []);
      shiftWindows.get(key)!.push(person);
    }

    for (const [shiftStart, shiftPeople] of shiftWindows) {
      const shiftStartMin = shiftTimeToMinutes(shiftStart);
      if (shiftStartMin === null) continue;

      // Alert is due 15 min after shift start
      const alertDueAt = shiftStartMin + 15;
      // Only fire within a 15-min window (cron runs every 15 min)
      if (nowMinutes < alertDueAt || nowMinutes >= alertDueAt + 15) continue;

      // Check who hasn't punched in
      const notReported = shiftPeople.filter((p) => !hasPunch(p.biometricId));
      const reported = shiftPeople.length - notReported.length;

      if (notReported.length === 0) {
        results.push(`${group.groupName} ${shiftStart}: all ${shiftPeople.length} reported`);
        continue;
      }

      const shiftLabel = minutesToHHMM(shiftStartMin);
      const lines = [
        `In the ${shiftLabel} hrs shift, only ${reported} of ${shiftPeople.length} people scheduled reported by ${minutesToHHMM(alertDueAt)} hrs. Why? Below are the people who have not reported:`,
        ...notReported.map((p) => `- ${p.name} (${p.code})`),
      ];
      const text = lines.join("\n");

      try {
        await workerRequest<{ id: string }>(settings, "/send", {
          method: "POST",
          body: {
            to: group.waGroupId,
            text,
            client_ref: `shift-noshow-${locationId}-${today}-${shiftStart.replace(":", "")}`,
          },
        });
        sent++;
        results.push(`${group.groupName} ${shiftStart}: ${notReported.length} not reported — sent`);
      } catch (err) {
        const msg = err instanceof WorkerError ? err.message : String(err);
        results.push(`${group.groupName} ${shiftStart}: send failed — ${msg}`);
      }
    }
  }

  return NextResponse.json({ ok: true, sent, today, nowMinutes: `${minutesToHHMM(nowMinutes)} IST`, results });
}
