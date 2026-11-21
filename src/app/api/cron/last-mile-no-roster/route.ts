import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";
import { biometricEnrolmentIdCandidates, normalizeBiometricEnrolmentId } from "@/lib/biometric/enrolment-resolution";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IST_OFFSET_MINUTES = 330;

function isoDateInIst(d = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.toISOString().slice(0, 10);
}

function nowInIst() {
  return new Date(Date.now() + IST_OFFSET_MINUTES * 60000);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  // ?test=1  — sends to Dark Store Testing group instead of real war rooms
  // ?force=1 — same as normal run but sends to real groups even when called manually
  const testMode = url.searchParams.get("test") === "1";
  const forceMode = url.searchParams.get("force") === "1";
  const debugMode = url.searchParams.get("debug") === "1";
  const testingGroupJid = "120363429732355530@g.us";

  if (!supabaseAdmin)
    return NextResponse.json({ error: "Supabase service role key not configured." }, { status: 500 });

  const admin = supabaseAdmin;
  const today = isoDateInIst();
  const istNow = nowInIst();
  const nowHour = istNow.getUTCHours();
  const nowHHMM = `${String(nowHour).padStart(2, "0")}:${String(istNow.getUTCMinutes()).padStart(2, "0")} IST`;

  // Fire only at 13:00 IST
  if (!testMode && !forceMode && nowHour !== 13) {
    return NextResponse.json({ ok: true, sent: 0, reason: "not alert hour (13:00 IST)", nowHHMM });
  }

  // --- 1. Load last_mile War Room groups + location_ids ---
  const botDb = reportBotDb();
  if (!botDb) return NextResponse.json({ error: "Report bot DB not configured." }, { status: 500 });

  const { data: groups, error: groupsErr } = await botDb
    .from("report_bot_groups")
    .select("id,wa_group_id,group_name,location_id")
    .eq("workspace", "last_mile")
    .eq("is_enabled", true)
    .not("location_id", "is", null);
  if (groupsErr) return NextResponse.json({ error: groupsErr.message }, { status: 500 });
  if (!groups?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no last_mile groups" });

  const locationIds = groups.map((g) => g.location_id as string);

  // --- 2. company_id + station details (cluster, TL) ---
  const { data: stationRows, error: locErr } = await admin
    .from("stations")
    .select("id,company_id,station_code,cluster_manager,station_manager_email")
    .in("id", locationIds)
    .limit(50);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
  if (!stationRows?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no stations found" });

  const companyId = stationRows[0].company_id as string;
  const stationById = new Map(stationRows.map((s) => [s.id as string, s]));

  const groupByLocation = new Map(
    groups
      .filter((g) => stationRows.some((s) => s.id === g.location_id) && g.wa_group_id)
      .map((g) => {
        const st = stationById.get(g.location_id as string);
        return [g.location_id as string, {
          waGroupId: g.wa_group_id as string,
          groupName: (g.group_name as string | null) ?? g.location_id as string,
          cluster: (st?.cluster_manager as string | null) ?? null,
          tlEmail: (st?.station_manager_email as string | null) ?? null,
        }];
      })
  );

  // --- 3. Load ALL roster plans covering today (approved + non-approved) ---
  const { data: allPlans, error: allPlansErr } = await admin
    .from("hr_roster_plans")
    .select("id,status,location_id")
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .lte("period_start", today)
    .or(`period_end.is.null,period_end.gte.${today}`);
  if (allPlansErr) return NextResponse.json({ error: allPlansErr.message }, { status: 500 });

  const approvedPlanIds = new Set((allPlans ?? []).filter((p) => p.status === "approved").map((p) => p.id as string));
  const unapprovedPlanIds = new Set((allPlans ?? []).filter((p) => p.status !== "approved").map((p) => p.id as string));
  const allPlanIds = [...approvedPlanIds, ...unapprovedPlanIds];

  // --- 4. Load all roster entries for today ---
  const { data: allEntries, error: entriesErr } = await admin
    .from("hr_roster_entries")
    .select("worker_id,worker_type,day_type,location_id,plan_id")
    .eq("company_id", companyId)
    .eq("roster_date", today)
    .in("location_id", locationIds)
    .in("plan_id", allPlanIds.length ? allPlanIds : ["__none__"])
    .limit(5000);
  if (entriesErr) return NextResponse.json({ error: entriesErr.message }, { status: 500 });
  if ((allEntries?.length ?? 0) >= 5000) console.warn("[no-roster] roster entry limit hit (5000)");

  // worker_id → { hasApprovedWorking, hasUnapprovedWorking, hasApprovedOff } per location
  // hasApprovedOff = weekly_off / holiday in an approved plan → legitimately not working, don't flag
  type RosterStatus = { hasApprovedWorking: boolean; hasUnapprovedWorking: boolean; hasApprovedOff: boolean };
  const rosterByWorkerAndLocation = new Map<string, RosterStatus>();
  for (const entry of allEntries ?? []) {
    const key = `${entry.worker_id}::${entry.location_id}`;
    const cur = rosterByWorkerAndLocation.get(key) ?? { hasApprovedWorking: false, hasUnapprovedWorking: false, hasApprovedOff: false };
    const isWorking = entry.day_type === "working";
    const isApproved = approvedPlanIds.has(entry.plan_id);
    if (isApproved && isWorking) cur.hasApprovedWorking = true;
    else if (!isApproved && isWorking) cur.hasUnapprovedWorking = true;
    else if (isApproved && !isWorking) cur.hasApprovedOff = true;
    rosterByWorkerAndLocation.set(key, cur);
  }

  // --- 5. Fetch active employees + contractors at these locations ---
  const [empResult, ctrResult] = await Promise.all([
    admin.from("employees")
      .select("id,employee_code,full_name,biometric_id,location_id")
      .eq("company_id", companyId)
      .in("location_id", locationIds)
      .eq("is_active", true)
      .is("deleted_at", null)
      .not("people_lifecycle_status", "in", '("offboarding","offboarded")')
      .limit(5000),
    admin.from("contractors")
      .select("id,dropx_id,full_name,biometric_id,location_id")
      .eq("company_id", companyId)
      .in("location_id", locationIds)
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(5000),
  ]);
  if (empResult.error) return NextResponse.json({ error: empResult.error.message }, { status: 500 });
  if (ctrResult.error) return NextResponse.json({ error: ctrResult.error.message }, { status: 500 });

  type Person = { id: string; code: string; name: string; biometricId: string | null; locationId: string };
  const activePeople: Person[] = [
    ...(empResult.data ?? []).map((e) => ({ id: e.id, code: e.employee_code ?? "—", name: e.full_name ?? "Unknown", biometricId: e.biometric_id, locationId: e.location_id as string })),
    ...(ctrResult.data ?? []).map((c) => ({ id: c.id, code: c.dropx_id ?? "—", name: c.full_name ?? "Unknown", biometricId: c.biometric_id, locationId: c.location_id as string })),
  ];

  // --- 6. Load today's punches ---
  const allBiometricIds = [...new Set(activePeople.flatMap((p) => biometricEnrolmentIdCandidates(p.biometricId)))];
  const BIO_CHUNK = 150;
  const bioChunks: string[][] = [];
  for (let i = 0; i < allBiometricIds.length; i += BIO_CHUNK) bioChunks.push(allBiometricIds.slice(i, i + BIO_CHUNK));

  const punchChunkResults = allBiometricIds.length
    ? await Promise.all(bioChunks.map((chunk) =>
        admin.from("attendance_punches")
          .select("enrolment_id,punch_time,punch_label")
          .eq("company_id", companyId)
          .eq("punch_date", today)
          .in("enrolment_id", chunk)
          .limit(5000)
      ))
    : [];
  const punchError = punchChunkResults.find((r) => r.error)?.error;
  if (punchError) return NextResponse.json({ error: punchError.message }, { status: 500 });
  const punchData = punchChunkResults.flatMap((r) => r.data ?? []);

  const punchedEnrolments = new Set<string>();
  for (const punch of punchData) {
    const label = (punch.punch_label ?? "").toLowerCase().trim();
    const isIn = !label || label.startsWith("in") || label === "i" || label.startsWith("check-in")
      || label.startsWith("checkin") || label === "entry" || label === "check in";
    if (isIn) punchedEnrolments.add(normalizeBiometricEnrolmentId(punch.enrolment_id));
  }

  function hasPunch(biometricId: string | null | undefined): boolean {
    for (const v of biometricEnrolmentIdCandidates(biometricId))
      if (punchedEnrolments.has(normalizeBiometricEnrolmentId(v))) return true;
    return false;
  }

  // --- 7. Classify each active person per location ---
  // Category A: punched in today but no roster entry at all
  // Category B: has a roster entry but only in unapproved plans
  // Category C: active, no roster entry, no punch (no roster, absent)
  type Flagged = { person: Person; reason: "no_roster" | "unapproved_roster" };
  const flaggedByLocation = new Map<string, Flagged[]>();

  for (const person of activePeople) {
    if (!groupByLocation.has(person.locationId)) continue;
    const key = `${person.id}::${person.locationId}`;
    const roster = rosterByWorkerAndLocation.get(key);

    let reason: Flagged["reason"] | null = null;

    if (!roster) {
      // No roster entry of any kind today
      reason = "no_roster";
    } else if (roster.hasApprovedOff) {
      // Weekly off / holiday in approved plan — legitimate, don't flag
    } else if (roster.hasApprovedWorking) {
      // Properly rostered for a working day — don't flag
    } else if (roster.hasUnapprovedWorking) {
      // Only in an unapproved plan
      reason = "unapproved_roster";
    }

    if (!reason) continue;

    const list = flaggedByLocation.get(person.locationId) ?? [];
    list.push({ person, reason });
    flaggedByLocation.set(person.locationId, list);
  }

  if (!flaggedByLocation.size) return NextResponse.json({ ok: true, sent: 0, today, nowHHMM, reason: "no roster issues found" });

  // --- 8. Send alerts ---
  const settings = await loadReportBotSettings(companyId);
  let sent = 0;
  const results: string[] = [];
  const sendTasks: Promise<void>[] = [];

  for (const [locationId, flagged] of flaggedByLocation) {
    const group = groupByLocation.get(locationId);
    if (!group || !flagged.length) continue;

    const noRoster = flagged.filter((f) => f.reason === "no_roster");
    const unapproved = flagged.filter((f) => f.reason === "unapproved_roster");

    const lines: string[] = ["Below people have 'no approved roster' or 'no roster'. Why?"];
    for (const { person, reason } of flagged) {
      const tag = reason === "unapproved_roster" ? " (roster not approved)" : "";
      lines.push(`- ${person.name} (${person.code})${tag}`);
    }
    const mentions: string[] = [];
    if (group.cluster) mentions.push(`@${group.cluster}`);
    if (group.tlEmail) mentions.push(`@${group.tlEmail.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`);
    if (mentions.length) lines.push("", mentions.join(" "));
    const text = lines.join("\n");

    const locShort = locationId.replace(/-/g, "").slice(-8);
    const dateShort = today.replace(/-/g, "").slice(2);
    const hourTag = String(istNow.getUTCHours()).padStart(2, "0");
    const clientRef = `lnr-${locShort}-${dateShort}-${hourTag}${testMode ? "-t" : forceMode ? "-f" : ""}`;
    const toGroup = testMode ? testingGroupJid : group.waGroupId;
    const label = group.groupName;

    sendTasks.push(
      workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: { to: toGroup, text, client_ref: clientRef },
      })
        .then(() => {
          sent++;
          results.push(`${label}: ${noRoster.length} no-roster, ${unapproved.length} unapproved — sent`);
        })
        .catch((err) => {
          const msg = err instanceof WorkerError ? err.message : String(err);
          results.push(`${label}: send failed — ${msg}`);
        })
    );
  }

  await Promise.all(sendTasks);

  const debugInfo = debugMode
    ? Object.fromEntries(
        [...flaggedByLocation.entries()].map(([locId, flagged]) => {
          const station = stationRows.find((s) => s.id === locId);
          return [
            station?.station_code ?? locId,
            flagged.map((f) => ({ name: f.person.name, code: f.person.code, reason: f.reason })),
          ];
        })
      )
    : undefined;

  return NextResponse.json({ ok: true, sent, today, nowHHMM, results, ...(debugInfo ? { debug: debugInfo } : {}) });
}
