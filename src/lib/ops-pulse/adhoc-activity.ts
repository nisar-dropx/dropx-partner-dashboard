import "server-only";

import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { adHocCategory, isAdHocHead, isApprovedPayment, paymentReason } from "@/lib/ops-pulse/performance-review";
import { readTrendPages } from "@/lib/ops-pulse/review-trends-data";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AdHocHeadRow = {
  id: string;
  code: string | null;
  name: string | null;
};

type AdHocRequestRow = {
  id: string;
  request_no: string | null;
  location_id: string | null;
  station_code: string | null;
  location_code: string | null;
  payment_head_id: string;
  work_date: string;
  amount: number | string | null;
  amount_approved: number | string | null;
  amount_requested: number | string | null;
  status: string | null;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  remarks: string | null;
  notes: string | null;
  details: Record<string, unknown> | null;
  payment_request_answers: Array<{
    answer_value: string | null;
    payment_head_questions: { question_text: string | null } | Array<{ question_text: string | null }> | null;
  }> | null;
};

type AdHocCashbookRow = {
  id: string;
  expense_date: string;
  station_code: string;
  expense_type: string | null;
  category: string | null;
  cps_sub_head: string | null;
  amount: number | string | null;
  remarks: string | null;
  raw_payload: Record<string, unknown> | null;
};

export type AdHocActivityDay = {
  date: string;
  vanCount: number;
  vanAmount: number;
  daCount: number;
  daAmount: number;
  cashbookVanCount: number;
  cashbookVanAmount: number;
  totalCount: number;
  totalAmount: number;
  entries: AdHocActivityEntry[];
};

export type AdHocActivityEntry = {
  id: string;
  source: "Payment request" | "Cashbook";
  reference: string;
  category: "Van" | "DA";
  amount: number;
  reason: string;
  remark: string;
  countedInTotal: boolean;
};

export type AdHocActivityStation = {
  id: string;
  code: string;
  name: string;
  cluster: string;
  region: string;
  vanCount: number;
  vanAmount: number;
  daCount: number;
  daAmount: number;
  cashbookVanCount: number;
  cashbookVanAmount: number;
  totalCount: number;
  totalAmount: number;
  days: AdHocActivityDay[];
};

export type AdHocActivityTotals = {
  vanCount: number;
  vanAmount: number;
  daCount: number;
  daAmount: number;
  cashbookVanCount: number;
  cashbookVanAmount: number;
  totalCount: number;
  totalAmount: number;
  activeStations: number;
};

export type AdHocActivityResult = {
  stations: AdHocActivityStation[];
  totals: AdHocActivityTotals;
  error: string | null;
};

function amount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export function validAdHocMonth(value: string | null | undefined, today: string) {
  const currentMonth = today.slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? "")) && String(value) <= currentMonth
    ? String(value)
    : currentMonth;
}

export function adHocMonthRange(month: string, today: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const finalDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return {
    from: `${month}-01`,
    to: month === today.slice(0, 7) ? today : finalDay,
    state: month === today.slice(0, 7) ? "mtd" as const : "closed" as const
  };
}

function validIsoDate(value: string | null | undefined, today: string) {
  const candidate = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || candidate > today) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
}

export function adHocDateRange(
  input: { from?: string; to?: string; month?: string },
  today: string
) {
  const requestedFrom = validIsoDate(input.from, today);
  const requestedTo = validIsoDate(input.to, today);
  if (requestedFrom || requestedTo) {
    const first = requestedFrom ?? requestedTo!;
    const last = requestedTo ?? requestedFrom!;
    const from = first <= last ? first : last;
    const to = first <= last ? last : first;
    return {
      from,
      to,
      state: from === to ? (from === today ? "today" as const : "single" as const) : "range" as const
    };
  }
  const month = validAdHocMonth(input.month, today);
  return adHocMonthRange(month, today);
}

export function adHocClusterLabel(location: CodLocationRow) {
  return String(location.cluster || location.cluster_manager || location.aom || "Unassigned").trim() || "Unassigned";
}

function normalizedWords(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export function isCashbookAdHocVan(row: Pick<AdHocCashbookRow, "category" | "cps_sub_head" | "expense_type">) {
  return [row.category, row.cps_sub_head, row.expense_type]
    .map(normalizedWords)
    .some((value) => ["VAN ADHOC", "ADHOC VAN", "VAN AD HOC", "AD HOC VAN"].includes(value));
}

function cashbookRequestReference(row: AdHocCashbookRow) {
  const payload = row.raw_payload ?? {};
  const candidates = [
    row.remarks,
    payload["Payment Request"],
    payload["Payment Request No"],
    payload["Request No"],
    payload["Remark"]
  ];
  return candidates.map(normalizedWords).find((value) => /^[A-Z0-9]{8,20}$/.test(value)) ?? null;
}

function answerReason(row: AdHocRequestRow) {
  for (const answer of row.payment_request_answers ?? []) {
    const relation = answer.payment_head_questions;
    const question = Array.isArray(relation) ? relation[0] : relation;
    const label = normalizedWords(question?.question_text);
    const value = String(answer.answer_value ?? "").trim();
    if (value && /(REASON|PURPOSE|DESCRIPTION|JUSTIFICATION|WHY)/.test(label)) return value;
  }
  return "";
}

function requestReason(row: AdHocRequestRow) {
  const fromAnswer = answerReason(row);
  if (fromAnswer) return fromAnswer;
  const details = row.details ?? {};
  for (const key of ["reason", "purpose", "description", "deployment_reason"]) {
    const value = String(details[key] ?? "").trim();
    if (value) return value;
  }
  return paymentReason(row);
}

function requestRemark(row: AdHocRequestRow) {
  return String(row.remarks ?? row.notes ?? "").trim() || "No remark recorded";
}

function blankStation(location: CodLocationRow): AdHocActivityStation {
  return {
    id: location.id,
    code: normalized(location.station_code),
    name: String(location.station_name || location.city || location.station_code).trim(),
    cluster: adHocClusterLabel(location),
    region: String(location.region || "Unassigned").trim() || "Unassigned",
    vanCount: 0,
    vanAmount: 0,
    daCount: 0,
    daAmount: 0,
    cashbookVanCount: 0,
    cashbookVanAmount: 0,
    totalCount: 0,
    totalAmount: 0,
    days: []
  };
}

function blankDay(date: string): AdHocActivityDay {
  return {
    date,
    vanCount: 0,
    vanAmount: 0,
    daCount: 0,
    daAmount: 0,
    cashbookVanCount: 0,
    cashbookVanAmount: 0,
    totalCount: 0,
    totalAmount: 0,
    entries: []
  };
}

export async function loadAdHocActivity(
  companyId: string,
  locations: CodLocationRow[],
  from: string,
  to: string
): Promise<AdHocActivityResult> {
  const stationRows = locations.map(blankStation);
  const empty: AdHocActivityResult = {
    stations: stationRows,
    totals: {
      vanCount: 0,
      vanAmount: 0,
      daCount: 0,
      daAmount: 0,
      cashbookVanCount: 0,
      cashbookVanAmount: 0,
      totalCount: 0,
      totalAmount: 0,
      activeStations: 0
    },
    error: null
  };
  if (!locations.length) return empty;
  if (!supabaseAdmin) return { ...empty, error: "Database service is unavailable." };
  const db = supabaseAdmin;

  const headsResult = await db
    .from("payment_heads")
    .select("id,code,name")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (headsResult.error) return { ...empty, error: headsResult.error.message };

  const heads = ((headsResult.data ?? []) as AdHocHeadRow[])
    .filter(isAdHocHead)
    .filter((head) => ["Van", "DA"].includes(adHocCategory(head)));
  if (!heads.length) return empty;

  const headById = new Map(heads.map((head) => [head.id, head]));
  const locationIds = locations.map((location) => location.id);
  const stationCodes = locations.map((location) => normalized(location.station_code));
  let requests: AdHocRequestRow[] = [];
  let cashbookRows: AdHocCashbookRow[] = [];
  try {
    const requestPage = (scopeColumn: "location_id" | "station_code" | "location_code", values: string[], offset: number) => db
      .from("payment_requests")
      .select("id,request_no,location_id,station_code,location_code,payment_head_id,work_date,amount,amount_approved,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id,remarks,notes,details,payment_request_answers(answer_value,payment_head_questions(question_text))")
      .eq("company_id", companyId)
      .in(scopeColumn, values)
      .in("payment_head_id", heads.map((head) => head.id))
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    const [byLocation, byStation, byLocationCode, cashbook] = await Promise.all([
      readTrendPages((offset) => requestPage("location_id", locationIds, offset)),
      readTrendPages((offset) => requestPage("station_code", stationCodes, offset)),
      readTrendPages((offset) => requestPage("location_code", stationCodes, offset)),
      readTrendPages((offset) => db
        .from("cps_cashbook_daily")
        .select("id,expense_date,station_code,expense_type,category,cps_sub_head,amount,remarks,raw_payload")
        .eq("company_id", companyId)
        .in("station_code", stationCodes)
        .gte("expense_date", from)
        .lte("expense_date", to)
        .order("expense_date", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 999))
    ]);
    requests = [...new Map([...byLocation, ...byStation, ...byLocationCode]
      .map((row) => [String((row as AdHocRequestRow).id), row as AdHocRequestRow])).values()];
    cashbookRows = cashbook as AdHocCashbookRow[];
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : "Adhoc activity could not be loaded." };
  }

  const byId = new Map(stationRows.map((station) => [station.id, station]));
  const byCode = new Map(stationRows.map((station) => [station.code, station]));
  const daysByStation = new Map<string, Map<string, AdHocActivityDay>>();
  const approvedRequestNumbers = new Set<string>();

  for (const request of requests) {
    if (!isApprovedPayment(request)) continue;
    const head = headById.get(request.payment_head_id);
    if (!head) continue;
    const station = (request.location_id ? byId.get(request.location_id) : null)
      ?? byCode.get(normalized(request.station_code || request.location_code));
    if (!station || !request.work_date) continue;
    if (request.request_no) approvedRequestNumbers.add(normalizedWords(request.request_no));
    const requestAmount = amount(request.amount_approved ?? request.amount ?? request.amount_requested);
    const category = adHocCategory(head);
    const stationDays = daysByStation.get(station.id) ?? new Map<string, AdHocActivityDay>();
    const day = stationDays.get(request.work_date) ?? blankDay(request.work_date);

    if (category === "Van") {
      station.vanCount += 1;
      station.vanAmount += requestAmount;
      day.vanCount += 1;
      day.vanAmount += requestAmount;
    } else if (category === "DA") {
      station.daCount += 1;
      station.daAmount += requestAmount;
      day.daCount += 1;
      day.daAmount += requestAmount;
    }
    if (category === "Van" || category === "DA") {
      day.entries.push({
        id: request.id,
        source: "Payment request",
        reference: request.request_no || request.id,
        category,
        amount: requestAmount,
        reason: requestReason(request),
        remark: requestRemark(request),
        countedInTotal: true
      });
    }
    station.totalCount += 1;
    station.totalAmount += requestAmount;
    day.totalCount += 1;
    day.totalAmount += requestAmount;
    stationDays.set(request.work_date, day);
    daysByStation.set(station.id, stationDays);
  }

  for (const cashbook of cashbookRows) {
    if (!isCashbookAdHocVan(cashbook)) continue;
    const station = byCode.get(normalized(cashbook.station_code));
    if (!station || !cashbook.expense_date) continue;
    const cashbookAmount = amount(cashbook.amount);
    const stationDays = daysByStation.get(station.id) ?? new Map<string, AdHocActivityDay>();
    const day = stationDays.get(cashbook.expense_date) ?? blankDay(cashbook.expense_date);
    station.cashbookVanCount += 1;
    station.cashbookVanAmount += cashbookAmount;
    day.cashbookVanCount += 1;
    day.cashbookVanAmount += cashbookAmount;

    const linkedRequest = cashbookRequestReference(cashbook);
    const countedInTotal = !linkedRequest || !approvedRequestNumbers.has(linkedRequest);
    if (countedInTotal) {
      station.vanCount += 1;
      station.vanAmount += cashbookAmount;
      station.totalCount += 1;
      station.totalAmount += cashbookAmount;
      day.vanCount += 1;
      day.vanAmount += cashbookAmount;
      day.totalCount += 1;
      day.totalAmount += cashbookAmount;
    }
    day.entries.push({
      id: cashbook.id,
      source: "Cashbook",
      reference: linkedRequest || cashbook.id,
      category: "Van",
      amount: cashbookAmount,
      reason: String(cashbook.cps_sub_head || cashbook.category || cashbook.expense_type || "Adhoc Van").trim(),
      remark: String(cashbook.remarks ?? "").trim() || "No remark recorded",
      countedInTotal
    });
    stationDays.set(cashbook.expense_date, day);
    daysByStation.set(station.id, stationDays);
  }

  for (const station of stationRows) {
    station.days = [...(daysByStation.get(station.id)?.values() ?? [])]
      .sort((left, right) => right.date.localeCompare(left.date));
  }
  stationRows.sort((left, right) => right.totalAmount - left.totalAmount || left.code.localeCompare(right.code));

  const totals = stationRows.reduce<AdHocActivityTotals>((current, station) => ({
    vanCount: current.vanCount + station.vanCount,
    vanAmount: current.vanAmount + station.vanAmount,
    daCount: current.daCount + station.daCount,
    daAmount: current.daAmount + station.daAmount,
    cashbookVanCount: current.cashbookVanCount + station.cashbookVanCount,
    cashbookVanAmount: current.cashbookVanAmount + station.cashbookVanAmount,
    totalCount: current.totalCount + station.totalCount,
    totalAmount: current.totalAmount + station.totalAmount,
    activeStations: current.activeStations + (station.totalCount || station.cashbookVanCount ? 1 : 0)
  }), {
    vanCount: 0,
    vanAmount: 0,
    daCount: 0,
    daAmount: 0,
    cashbookVanCount: 0,
    cashbookVanAmount: 0,
    totalCount: 0,
    totalAmount: 0,
    activeStations: 0
  });

  return { stations: stationRows, totals, error: null };
}
