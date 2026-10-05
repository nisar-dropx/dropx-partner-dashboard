import type { CpsSnapshot } from "../ops-pulse/cps";
import {
  summarizeDaDetails,
  type CpsCalculationEvidence,
  type CpsStaffDay,
} from "../ops-pulse/cps-details";
import type { RentRecord } from "./rent";
import { addAmounts, mgEstimate, monthEnd, subtractAmounts } from "./pricing";

export function evidenceStations(requested: unknown, allowed: string[]) {
  if (typeof requested !== "string") throw Error("Choose a permitted station.");
  const codes = [
    ...new Set(
      requested
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !codes.length ||
    codes.length > 150 ||
    codes.some((c) => !allowed.includes(c))
  )
    throw Error("The requested stations are outside your Finance access.");
  return codes;
}
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const dates = (from: string, to: string) =>
  Array.from({ length: Math.max(0, daysBetween(from, to)) }, (_, i) =>
    new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10),
  );
export const calendarAccrual = (monthly: string, date: string) =>
  Number(
    subtractAmounts(
      mgEstimate(
        monthly,
        Number(date.slice(8)),
        Number(monthEnd(date.slice(0, 7)).slice(8)),
      ),
      mgEstimate(
        monthly,
        Number(date.slice(8)) - 1,
        Number(monthEnd(date.slice(0, 7)).slice(8)),
      ),
    ),
  );

/** Explicit Finance-only projection; every person and cost is filtered by the final station/day coverage. */
export type PnlFuel = {
  id: string;
  station_code: string;
  transaction_date: string;
  vehicle_no: string | null;
  provider: string;
  transaction_id: string;
  product: string | null;
  litres: number;
  amount: number;
};
export function buildPnlEvidence(
  snapshot: CpsSnapshot,
  evidence: CpsCalculationEvidence,
  rents: RentRecord[],
  from: string,
  to: string,
  codes: string[],
  fuel: PnlFuel[] = [],
) {
  const allowed = new Set(codes),
    cutoffs = new Map<string, string>();
  for (const d of snapshot.daily)
    if (
      allowed.has(d.station_code) &&
      d.shipment_present &&
      d.work_date >= from &&
      d.work_date <= to
    )
      cutoffs.set(
        d.station_code,
        [cutoffs.get(d.station_code) || "", d.work_date].sort().at(-1)!,
      );
  const included = (station: string, date: string) =>
    allowed.has(station) &&
    date >= from &&
    date <= (cutoffs.get(station) || "");
  const staffMap = new Map<
    string,
    {
      person_id: string;
      name: string;
      code: string;
      role: string;
      station: string;
      head: string;
      group: string;
      amount: number;
      days: CpsStaffDay[];
    }
  >();
  for (const d of evidence.staff)
    if (included(d.station_code, d.date)) {
      const k = `${d.person_id}/${d.station_code}/${d.head}/${d.group}`;
      const item = staffMap.get(k) ?? {
        person_id: d.person_id,
        name: d.name,
        code: d.code,
        role: d.role,
        station: d.station_code,
        head: d.head,
        group: d.group,
        amount: 0,
        days: [],
      };
      item.amount += d.amount;
      item.days.push(d);
      staffMap.set(k, item);
    }
  const rentRows = rents.flatMap((r) => {
    const end = [
      to,
      cutoffs.get(r.allocation_station_code) || "",
      r.effective_to || to,
    ].sort()[0];
    const start = [from, r.effective_from].sort().at(-1)!;
    if (!allowed.has(r.allocation_station_code) || start > end) return [];
    const monthGroups = new Map<string, string[]>();
    for (const date of dates(start, end)) {
      const month = date.slice(0, 7);
      monthGroups.set(month, [...(monthGroups.get(month) || []), date]);
    }
    return [...monthGroups].map(([month, workDates]) => ({
      id: r.id,
      station: r.allocation_station_code,
      site: r.site_code,
      payee: r.payee_name,
      monthly_rent: Number(r.monthly_rent),
      monthly_maintenance: Number(r.monthly_maintenance),
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      month,
      calendar_days: Number(monthEnd(month).slice(8)),
      from: workDates[0],
      to: workDates.at(-1)!,
      days: workDates.length,
      amount: workDates.reduce(
        (sum, date) =>
          sum +
          calendarAccrual(
            addAmounts([r.monthly_rent, r.monthly_maintenance])!,
            date,
          ),
        0,
      ),
    }));
  });
  const bills = [
    ...new Map(
      (snapshot.expense_periods ?? []).map((b) => [
        `${b.source}/${b.source_id}`,
        b,
      ]),
    ).values(),
  ].flatMap((b) => {
    const start = [from, b.period_from].sort().at(-1)!,
      end = [to, b.period_to, cutoffs.get(b.station_code) || ""].sort()[0];
    if (!allowed.has(b.station_code) || start > end) return [];
    const totalDays = daysBetween(b.period_from, b.period_to);
    const amount =
      (Math.round(
        (Number(b.amount) * 100 * daysBetween(b.period_from, end)) / totalDays,
      ) -
        Math.round(
          (Number(b.amount) * 100 * (daysBetween(b.period_from, start) - 1)) /
            totalDays,
        )) /
      100;
    return [
      {
        ...b,
        amount: Number(b.amount),
        considered_from: start,
        considered_to: end,
        considered_days: daysBetween(start, end),
        period_days: totalDays,
        considered_amount: amount,
      },
    ];
  });
  const vehicles = (snapshot.vehicles ?? [])
    .filter(
      (v) =>
        allowed.has(v.station_code) &&
        v.from_date <= (cutoffs.get(v.station_code) || ""),
    )
    .map((v) => {
      const start = [from, v.from_date].sort().at(-1)!,
        end = [to, v.through_date, cutoffs.get(v.station_code)!].sort()[0];
      const rentLedger = snapshot.breakup.filter(l=>l.source==='Fleet Vehicle Master' && l.station_code===v.station_code && l.sub_head===`Vehicle rent · ${v.vehicle_no}` && l.work_date>=start && l.work_date<=end);
      const complete = start === v.from_date && end === v.through_date;
      const contiguous = v.days === daysBetween(v.from_date, v.through_date);
      return {
        ...v,
        daily_rent: v.daily_rent == null ? null : Number(v.daily_rent),
        monthly_rent: v.monthly_rent == null ? null : Number(v.monthly_rent),
        considered_from: start,
        considered_to: end,
        calendar_days: Number(monthEnd(start.slice(0, 7)).slice(8)),
        considered_days: complete
          ? v.days
          : contiguous
            ? daysBetween(start, end)
            : null,
        rent_blocked_days: new Set(rentLedger.filter(l=>Number(l.amount)===0).map(l=>l.work_date)).size,
        considered_amount: rentLedger.length
          ? rentLedger.reduce((sum,l)=>sum+Number(l.amount),0)
          : complete
          ? v.amount == null
            ? null
            : Number(v.amount)
          : contiguous && v.daily_rent != null
            ? Number(v.daily_rent)*daysBetween(start,end)
          : contiguous && v.monthly_rent != null
            ? dates(start, end).reduce(
                (sum, date) =>
                  sum + calendarAccrual(String(v.monthly_rent), date),
                0,
              )
            : null,
      };
    });
  const daDays = evidence.associates.filter((d) =>
    included(d.station_code, d.date),
  );
  return {
    coverage: codes.map((station) => ({
      station,
      from,
      through: cutoffs.get(station) ?? null,
    })),
    staff: [...staffMap.values()].sort((a, b) => b.amount - a.amount),
    associates: summarizeDaDetails(daDays),
    associateDays: daDays,
    rents: rentRows,
    vehicles,
    bills,
    fuel: fuel.filter((f) => included(f.station_code, f.transaction_date)),
    ledger: snapshot.breakup.filter((l) =>
      included(l.station_code, l.work_date),
    ),
    gaps: (snapshot.gaps ?? []).filter(
      (g) =>
        allowed.has(g.station_code) &&
        g.first_date <= (cutoffs.get(g.station_code) || ""),
    ),
  };
}
export type PnlEvidence = ReturnType<typeof buildPnlEvidence>;
