import "server-only";

import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { adHocCategory, isAdHocHead, isApprovedPayment } from "@/lib/ops-pulse/performance-review";
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
};

export type AdHocActivityDay = {
  date: string;
  vanCount: number;
  vanAmount: number;
  daCount: number;
  daAmount: number;
  totalCount: number;
  totalAmount: number;
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
  totalCount: number;
  totalAmount: number;
  days: AdHocActivityDay[];
};

export type AdHocActivityTotals = {
  vanCount: number;
  vanAmount: number;
  daCount: number;
  daAmount: number;
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

function clusterLabel(location: CodLocationRow) {
  return String(location.cluster || location.cluster_manager || "Unassigned").trim() || "Unassigned";
}

function blankStation(location: CodLocationRow): AdHocActivityStation {
  return {
    id: location.id,
    code: normalized(location.station_code),
    name: String(location.station_name || location.city || location.station_code).trim(),
    cluster: clusterLabel(location),
    region: String(location.region || "Unassigned").trim() || "Unassigned",
    vanCount: 0,
    vanAmount: 0,
    daCount: 0,
    daAmount: 0,
    totalCount: 0,
    totalAmount: 0,
    days: []
  };
}

function blankDay(date: string): AdHocActivityDay {
  return { date, vanCount: 0, vanAmount: 0, daCount: 0, daAmount: 0, totalCount: 0, totalAmount: 0 };
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
    totals: { vanCount: 0, vanAmount: 0, daCount: 0, daAmount: 0, totalCount: 0, totalAmount: 0, activeStations: 0 },
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
  let requests: AdHocRequestRow[] = [];
  try {
    requests = await readTrendPages((offset) => db
      .from("payment_requests")
      .select("id,request_no,location_id,station_code,location_code,payment_head_id,work_date,amount,amount_approved,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id")
      .eq("company_id", companyId)
      .in("location_id", locationIds)
      .in("payment_head_id", heads.map((head) => head.id))
      .gte("work_date", from)
      .lte("work_date", to)
      .order("work_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999)) as AdHocRequestRow[];
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : "Adhoc activity could not be loaded." };
  }

  const byId = new Map(stationRows.map((station) => [station.id, station]));
  const byCode = new Map(stationRows.map((station) => [station.code, station]));
  const daysByStation = new Map<string, Map<string, AdHocActivityDay>>();

  for (const request of requests) {
    if (!isApprovedPayment(request)) continue;
    const head = headById.get(request.payment_head_id);
    if (!head) continue;
    const station = (request.location_id ? byId.get(request.location_id) : null)
      ?? byCode.get(normalized(request.station_code || request.location_code));
    if (!station || !request.work_date) continue;
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
    station.totalCount += 1;
    station.totalAmount += requestAmount;
    day.totalCount += 1;
    day.totalAmount += requestAmount;
    stationDays.set(request.work_date, day);
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
    totalCount: current.totalCount + station.totalCount,
    totalAmount: current.totalAmount + station.totalAmount,
    activeStations: current.activeStations + (station.totalCount ? 1 : 0)
  }), { vanCount: 0, vanAmount: 0, daCount: 0, daAmount: 0, totalCount: 0, totalAmount: 0, activeStations: 0 });

  return { stations: stationRows, totals, error: null };
}
