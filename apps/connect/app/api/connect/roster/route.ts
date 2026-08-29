import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

type WorkerType = "employee" | "contractor";
type Shift = { id: string; name: string; code: string; start_time: string; end_time: string };
type PlanMeta = { status: string; roster_kind?: string; effective_from?: string; superseded_at?: string | null; revision_no?: number | null };
type Entry = { id: string; company_id: string; plan_id: string; worker_type: WorkerType; worker_id: string; roster_date: string; day_type: "working" | "weekly_off"; shift_id: string | null; location_id: string | null; hr_shifts?: Shift | Shift[] | null; hr_roster_plans?: PlanMeta | PlanMeta[] | null };
type SwapRow = {
  id: string; requester_entry_id: string; partner_entry_id: string;
  requester_worker_type: WorkerType; requester_worker_id: string;
  partner_worker_type: WorkerType; partner_worker_id: string;
  requester_shift_id: string | null; partner_shift_id: string | null;
  requester_day_type: "working" | "weekly_off"; partner_day_type: "working" | "weekly_off";
  roster_date: string; status: string; requester_note: string | null; partner_note: string | null; requested_at: string;
};

function db() { if (!supabaseAdmin) throw new Error("Database configuration is unavailable."); return supabaseAdmin; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function todayIndia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function addDays(value: string, days: number) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
const ROSTER_VIEW_DAYS = Math.min(35, Math.max(7, Number(process.env.CONNECT_ROSTER_VIEW_DAYS ?? 30) || 30));
function appWorkerType(profileType: string): WorkerType | null { return profileType === "employee" || profileType === "contractor" ? profileType : null; }
function shiftOf(entry: Entry) { return relation(entry.hr_shifts); }
function planOf(entry: Entry) { return relation(entry.hr_roster_plans); }
function isoWeekday(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

async function expandRecurringOwnEntries(account: ConnectAccount, workerType: WorkerType, start: string, direct: Entry[]) {
  const byDate = new Map(direct.map((entry) => [entry.roster_date, entry]));
  let locationId = direct.find((entry) => entry.location_id)?.location_id ?? null;
  if (!locationId) {
    const today = todayIndia();
    const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
    const engagement = await db().from("hr_engagements").select("id").eq("company_id", account.companyId).eq("worker_type", workerType).eq(workerColumn, account.id).eq("status", "active").maybeSingle();
    if (!engagement.data) return direct;
    const assignment = await db().from("hr_work_assignments").select("location_id").eq("company_id", account.companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).order("effective_from", { ascending: false }).limit(1).maybeSingle();
    locationId = assignment.data?.location_id ?? null;
  }
  if (!locationId) return direct;

  const patternResult = await db().from("hr_roster_entries")
    .select("id,company_id,plan_id,worker_type,worker_id,roster_date,day_type,shift_id,location_id,hr_shifts(id,name,code,start_time,end_time),hr_roster_plans!inner(status,roster_kind,effective_from,superseded_at,revision_no)")
    .eq("company_id", account.companyId).eq("worker_type", workerType).eq("worker_id", account.id)
    .eq("location_id", locationId)
    .eq("hr_roster_plans.status", "approved")
    .eq("hr_roster_plans.roster_kind", "recurring_weekly");
  if (patternResult.error) throw new Error(patternResult.error.message);
  if (!patternResult.data?.length) return direct;

  const index = new Map<string, Array<{ effectiveFrom: string; supersededAt: string | null; revisionNo: number; entry: Entry }>>();
  for (const row of patternResult.data ?? []) {
    const entry = row as unknown as Entry;
    const plan = relation(entry.hr_roster_plans);
    if (!plan?.effective_from) continue;
    const key = String(isoWeekday(entry.roster_date));
    index.set(key, [...(index.get(key) ?? []), {
      effectiveFrom: plan.effective_from,
      supersededAt: plan.superseded_at ?? null,
      revisionNo: Number(plan.revision_no ?? 0),
      entry
    }]);
  }
  for (const values of index.values()) {
    values.sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom) || right.revisionNo - left.revisionNo);
  }

  const expanded = [...direct];
  for (let offset = 0; offset < ROSTER_VIEW_DAYS; offset += 1) {
    const date = addDays(start, offset);
    if (byDate.has(date)) continue;
    const match = index.get(String(isoWeekday(date)))?.find((candidate) => candidate.effectiveFrom <= date && (!candidate.supersededAt || date < candidate.supersededAt));
    if (!match) continue;
    expanded.push({ ...match.entry, id: `preview:${date}`, roster_date: date });
  }
  return expanded.sort((left, right) => left.roster_date.localeCompare(right.roster_date));
}

async function accountFrom(url: URL, body?: Record<string, unknown>) {
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  const workerType = appWorkerType(profileType);
  if (!accountId || !workerType) throw new Error("Roster is available for employees and independent contractors.");
  const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
  return { account, workerType };
}

async function swapCutoff(companyId: string) {
  const result = await db().from("hr_company_settings").select("roster_swap_lead_hours").eq("company_id", companyId).maybeSingle();
  if (result.error && !/roster_swap_lead_hours/i.test(result.error.message)) throw new Error(result.error.message);
  return Number(result.data?.roster_swap_lead_hours ?? 24);
}

function assertBeforeCutoff(entry: Entry, leadHours: number) {
  const start = shiftOf(entry)?.start_time?.slice(0, 8) ?? "00:00:00";
  const beginsAt = Date.parse(`${entry.roster_date}T${start}+05:30`);
  if (!Number.isFinite(beginsAt) || Date.now() > beginsAt - leadHours * 3_600_000) throw new Error(`Shift swaps close ${leadHours} hours before the shift.`);
}

async function immediateManager(companyId: string, workerType: WorkerType, workerId: string) {
  const today = todayIndia();
  const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
  const engagement = await db().from("hr_engagements").select("id").eq("company_id", companyId).eq("worker_type", workerType).eq(workerColumn, workerId).eq("status", "active").maybeSingle();
  if (engagement.error || !engagement.data) throw new Error(engagement.error?.message ?? "Your People engagement is not configured.");
  const assignment = await db().from("hr_work_assignments").select("id").eq("company_id", companyId).eq("engagement_id", engagement.data.id).eq("is_primary", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (assignment.error || !assignment.data) throw new Error(assignment.error?.message ?? "Your current work assignment is not configured.");
  const reporting = await db().from("hr_reporting_relationships").select("manager_assignment_id").eq("company_id", companyId).eq("subject_assignment_id", assignment.data.id).eq("relationship_type", "solid_line").eq("is_primary", true).lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  if (reporting.error || !reporting.data) throw new Error(reporting.error?.message ?? "Your immediate reporting manager is not configured.");
  const managerAssignment = await db().from("hr_work_assignments").select("engagement_id").eq("company_id", companyId).eq("id", reporting.data.manager_assignment_id).maybeSingle();
  if (managerAssignment.error || !managerAssignment.data) throw new Error(managerAssignment.error?.message ?? "Manager assignment is inactive.");
  const managerEngagement = await db().from("hr_engagements").select("person_id").eq("company_id", companyId).eq("id", managerAssignment.data.engagement_id).eq("status", "active").maybeSingle();
  if (managerEngagement.error || !managerEngagement.data) throw new Error(managerEngagement.error?.message ?? "Manager engagement is inactive.");
  const link = await db().from("hr_user_person_links").select("user_id,status").eq("company_id", companyId).eq("person_id", managerEngagement.data.person_id).maybeSingle();
  if (link.error || !link.data || link.data.status !== "active") throw new Error(link.error?.message ?? "Your manager does not have an active People login.");
  return link.data.user_id;
}

async function notifyWorker(input: { companyId: string; workerType: WorkerType; workerId: string; event: string; sourceKey: string; title: string; body: string; data?: Record<string, unknown> }) {
  await db().from("mob_app_notifications").upsert({ company_id: input.companyId, recipient_profile_type: input.workerType, recipient_account_id: input.workerId, event_code: input.event, source_key: input.sourceKey, title: input.title, body: input.body, route: "roster", data: input.data ?? {}, push_status: "not_configured" }, { onConflict: "company_id,event_code,source_key,recipient_account_id", ignoreDuplicates: true });
}

async function rosterPayload(account: ConnectAccount, workerType: WorkerType) {
  const start = todayIndia();
  const end = addDays(start, ROSTER_VIEW_DAYS - 1);
  const entryResult = await db().from("hr_roster_entries")
    .select("id,company_id,plan_id,worker_type,worker_id,roster_date,day_type,shift_id,location_id,hr_shifts(id,name,code,start_time,end_time),hr_roster_plans!inner(status)")
    .eq("company_id", account.companyId).eq("worker_type", workerType).eq("worker_id", account.id)
    .gte("roster_date", start).lte("roster_date", end).eq("hr_roster_plans.status", "approved").order("roster_date");
  if (entryResult.error) throw new Error(entryResult.error.message);
  const own = await expandRecurringOwnEntries(account, workerType, start, (entryResult.data ?? []) as unknown as Entry[]);
  const locations = [...new Set(own.map((entry) => entry.location_id).filter(Boolean))] as string[];
  let colleagueEntries: Entry[] = [];
  if (locations.length) {
    const colleagues = await db().from("hr_roster_entries")
      .select("id,company_id,plan_id,worker_type,worker_id,roster_date,day_type,shift_id,location_id,hr_shifts(id,name,code,start_time,end_time),hr_roster_plans!inner(status)")
      .eq("company_id", account.companyId).in("location_id", locations).gte("roster_date", start).lte("roster_date", end).eq("hr_roster_plans.status", "approved");
    if (colleagues.error) throw new Error(colleagues.error.message);
    colleagueEntries = (colleagues.data ?? []) as unknown as Entry[];
  }
  const swapColumns = "id,requester_entry_id,partner_entry_id,requester_worker_type,requester_worker_id,partner_worker_type,partner_worker_id,requester_shift_id,partner_shift_id,requester_day_type,partner_day_type,roster_date,status,requester_note,partner_note,requested_at";
  const [requesterSwaps, partnerSwaps] = await Promise.all([
    db().from("hr_roster_swap_requests").select(swapColumns).eq("company_id", account.companyId).eq("requester_worker_type", workerType).eq("requester_worker_id", account.id).order("requested_at", { ascending: false }).limit(30),
    db().from("hr_roster_swap_requests").select(swapColumns).eq("company_id", account.companyId).eq("partner_worker_type", workerType).eq("partner_worker_id", account.id).order("requested_at", { ascending: false }).limit(30)
  ]);
  if (requesterSwaps.error || partnerSwaps.error) throw new Error(requesterSwaps.error?.message ?? partnerSwaps.error?.message ?? "Roster could not be loaded.");
  const swaps = [...new Map([...(requesterSwaps.data ?? []), ...(partnerSwaps.data ?? [])].map((item) => [item.id, item])).values()]
    .sort((left, right) => String(right.requested_at).localeCompare(String(left.requested_at)))
    .slice(0, 30) as unknown as SwapRow[];
  const participantEntries = [
    ...colleagueEntries.map((item) => ({ worker_type: item.worker_type, worker_id: item.worker_id })),
    ...swaps.flatMap((item) => [
      { worker_type: item.requester_worker_type, worker_id: item.requester_worker_id },
      { worker_type: item.partner_worker_type, worker_id: item.partner_worker_id }
    ])
  ];
  const employeeIds = [...new Set(participantEntries.filter((item) => item.worker_type === "employee").map((item) => item.worker_id))];
  const contractorIds = [...new Set(participantEntries.filter((item) => item.worker_type === "contractor").map((item) => item.worker_id))];
  const storedShiftIds = [...new Set(swaps.flatMap((item) => [item.requester_shift_id, item.partner_shift_id]).filter(Boolean))] as string[];
  const [employees, contractors, storedShifts] = await Promise.all([
    employeeIds.length ? db().from("employees").select("id,employee_code,full_name").in("id", employeeIds) : Promise.resolve({ data: [], error: null }),
    contractorIds.length ? db().from("contractors").select("id,dropx_id,full_name").in("id", contractorIds) : Promise.resolve({ data: [], error: null }),
    storedShiftIds.length ? db().from("hr_shifts").select("id,name,code,start_time,end_time").in("id", storedShiftIds) : Promise.resolve({ data: [], error: null })
  ]);
  if (employees.error || contractors.error || storedShifts.error) throw new Error(employees.error?.message ?? contractors.error?.message ?? storedShifts.error?.message ?? "Roster could not be loaded.");
  const names = new Map<string, { name: string; code: string }>();
  for (const item of employees.data ?? []) names.set(`employee:${item.id}`, { name: item.full_name, code: item.employee_code });
  for (const item of contractors.data ?? []) names.set(`contractor:${item.id}`, { name: item.full_name, code: item.dropx_id });
  const shifts = new Map<string, Shift>();
  for (const item of storedShifts.data ?? []) shifts.set(item.id, item as Shift);
  const leadHours = await swapCutoff(account.companyId);
  const entriesById = new Map([...own, ...colleagueEntries].map((entry) => [entry.id, entry]));
  const days = own.map((entry) => ({
    id: entry.id, date: entry.roster_date, dayType: entry.day_type, locationId: entry.location_id,
    shift: entry.day_type === "weekly_off" ? null : shiftOf(entry),
    canSwap: !entry.id.startsWith("preview:") && (() => { try { assertBeforeCutoff(entry, leadHours); return true; } catch { return false; } })(),
    partners: colleagueEntries.filter((candidate) => candidate.id !== entry.id && candidate.roster_date === entry.roster_date && candidate.location_id === entry.location_id && !(candidate.worker_type === workerType && candidate.worker_id === account.id)).map((candidate) => ({ id: candidate.id, workerType: candidate.worker_type, workerId: candidate.worker_id, ...names.get(`${candidate.worker_type}:${candidate.worker_id}`), dayType: candidate.day_type, shift: candidate.day_type === "weekly_off" ? null : shiftOf(candidate) }))
  }));
  const requests = swaps.map((request) => {
    const requesterEntry = entriesById.get(request.requester_entry_id);
    const partnerEntry = entriesById.get(request.partner_entry_id);
    const isRequester = request.requester_worker_type === workerType && request.requester_worker_id === account.id;
    const counterpartKey = isRequester
      ? `${request.partner_worker_type}:${request.partner_worker_id}`
      : `${request.requester_worker_type}:${request.requester_worker_id}`;
    return {
      id: request.id,
      date: request.roster_date,
      status: request.status,
      note: request.requester_note,
      requestedAt: request.requested_at,
      isRequester,
      isPartner: !isRequester,
      counterpart: names.get(counterpartKey) ?? { name: "Colleague", code: "" },
      requesterShift: request.requester_day_type === "weekly_off" ? null : (requesterEntry ? shiftOf(requesterEntry) : null) ?? (request.requester_shift_id ? shifts.get(request.requester_shift_id) ?? null : null),
      partnerShift: request.partner_day_type === "weekly_off" ? null : (partnerEntry ? shiftOf(partnerEntry) : null) ?? (request.partner_shift_id ? shifts.get(request.partner_shift_id) ?? null : null),
      requesterDayType: request.requester_day_type,
      partnerDayType: request.partner_day_type
    };
  });
  return { days, leadHours, requests, self: { workerType, workerId: account.id }, viewDays: ROSTER_VIEW_DAYS };
}

export async function GET(request: Request) {
  try { const { account, workerType } = await accountFrom(new URL(request.url)); return NextResponse.json(await rosterPayload(account, workerType), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load roster." }, { status: 400 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType } = await accountFrom(new URL(request.url), body);
    const requesterEntryId = clean(body.requesterEntryId); const partnerEntryId = clean(body.partnerEntryId); const note = clean(body.note).slice(0, 500);
    if (!requesterEntryId || !partnerEntryId || requesterEntryId === partnerEntryId) throw new Error("Select a valid shift partner.");
    const entries = await db().from("hr_roster_entries").select("id,company_id,plan_id,worker_type,worker_id,roster_date,day_type,shift_id,location_id,hr_shifts(id,name,code,start_time,end_time),hr_roster_plans!inner(status)").eq("company_id", account.companyId).in("id", [requesterEntryId, partnerEntryId]);
    if (entries.error || entries.data?.length !== 2) throw new Error(entries.error?.message ?? "One of the roster entries is unavailable.");
    const requester = entries.data.find((item) => item.id === requesterEntryId) as unknown as Entry;
    const partner = entries.data.find((item) => item.id === partnerEntryId) as unknown as Entry;
    if (requester.worker_type !== workerType || requester.worker_id !== account.id) throw new Error("You can request a swap only for your own roster.");
    if (planOf(requester)?.status !== "approved" || planOf(partner)?.status !== "approved") throw new Error("Only approved roster shifts can be swapped.");
    if (requester.roster_date !== partner.roster_date || requester.location_id !== partner.location_id) throw new Error("Choose a colleague from the same date and location.");
    const leadHours = await swapCutoff(account.companyId); assertBeforeCutoff(requester, leadHours);
    const approverUserId = await immediateManager(account.companyId, workerType, account.id);
    const created = await db().from("hr_roster_swap_requests").insert({ company_id: account.companyId, requester_entry_id: requester.id, partner_entry_id: partner.id, requester_worker_type: requester.worker_type, requester_worker_id: requester.worker_id, partner_worker_type: partner.worker_type, partner_worker_id: partner.worker_id, roster_date: requester.roster_date, requester_shift_id: requester.shift_id, partner_shift_id: partner.shift_id, requester_day_type: requester.day_type, partner_day_type: partner.day_type, approver_user_id: approverUserId, requester_note: note || null }).select("id").single();
    if (created.error) throw new Error(created.error.code === "23505" ? "One of these shifts already has a pending swap request." : created.error.message);
    await notifyWorker({ companyId: account.companyId, workerType: partner.worker_type, workerId: partner.worker_id, event: "roster_swap_requested", sourceKey: created.data.id, title: "Shift swap request", body: `${account.name ?? account.reference ?? "A colleague"} wants to swap the ${requester.roster_date} shift with you.`, data: { requestId: created.data.id, rosterDate: requester.roster_date } });
    return NextResponse.json({ ok: true, notice: "Swap request sent to your colleague." });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to request the shift swap." }, { status: 400 }); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType } = await accountFrom(new URL(request.url), body);
    const requestId = clean(body.requestId); const action = clean(body.action); const note = clean(body.note).slice(0, 500);
    if (!requestId || !["accept", "reject", "cancel"].includes(action)) throw new Error("Choose a valid swap action.");
    const current = await db().from("hr_roster_swap_requests").select("*").eq("company_id", account.companyId).eq("id", requestId).maybeSingle();
    if (current.error || !current.data) throw new Error(current.error?.message ?? "Swap request was not found.");
    if (action === "cancel") {
      if (current.data.requester_worker_type !== workerType || current.data.requester_worker_id !== account.id || !["pending_partner", "pending_manager"].includes(current.data.status)) throw new Error("This swap request cannot be cancelled.");
      const cancelled = await db().from("hr_roster_swap_requests").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", requestId).in("status", ["pending_partner", "pending_manager"]);
      if (cancelled.error) throw new Error(cancelled.error.message);
      await notifyWorker({ companyId: account.companyId, workerType: current.data.partner_worker_type, workerId: current.data.partner_worker_id, event: "roster_swap_cancelled", sourceKey: requestId, title: "Shift swap cancelled", body: `The swap request for ${current.data.roster_date} was cancelled.` });
      return NextResponse.json({ ok: true, notice: "Swap request cancelled." });
    }
    const response = await db().rpc("hr_partner_decide_roster_swap", { p_company_id: account.companyId, p_request_id: requestId, p_partner_worker_type: workerType, p_partner_worker_id: account.id, p_accept: action === "accept", p_note: note || null });
    if (response.error) throw new Error(response.error.message);
    const decided = response.data as typeof current.data;
    await notifyWorker({ companyId: account.companyId, workerType: decided.requester_worker_type, workerId: decided.requester_worker_id, event: action === "accept" ? "roster_swap_partner_accepted" : "roster_swap_rejected", sourceKey: requestId, title: action === "accept" ? "Swap partner accepted" : "Shift swap declined", body: action === "accept" ? `Your colleague accepted. Manager approval is now pending for ${decided.roster_date}.` : `Your colleague declined the swap for ${decided.roster_date}.` });
    if (action === "accept") await db().from("people_web_notifications").upsert({ company_id: account.companyId, recipient_user_id: decided.approver_user_id, event_code: "roster_swap_approval_required", title: "Shift swap awaiting approval", body: `Both people accepted a shift swap for ${decided.roster_date}.`, href: "/approvals", source_key: requestId, data: { requestId, rosterDate: decided.roster_date } }, { onConflict: "company_id,event_code,source_key,recipient_user_id", ignoreDuplicates: true });
    return NextResponse.json({ ok: true, notice: action === "accept" ? "Accepted. Sent to the reporting manager." : "Swap request declined." });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update the shift swap." }, { status: 400 }); }
}
