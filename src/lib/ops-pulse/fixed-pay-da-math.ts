import { cpsShipmentCount } from "./cps";
import type { CpsDaDetail } from "./cps-details";

export type FixedPayDaPersonDay = {
  workerId: string;
  dropxId: string;
  name: string;
  providerIds: string[];
  salary: number;
  deliveries: number;
  customerReturns: number;
  shipments: number;
  pendingFixedDates: string[];
  workDates: string[];
};

export type FixedPayDaDay = {
  date: string;
  associates: number;
  salary: number;
  deliveries: number;
  customerReturns: number;
  shipments: number;
  pendingDays: number;
  cps: number | null;
  people: FixedPayDaPersonDay[];
};

export type FixedPayDaStation = {
  id: string;
  code: string;
  name: string;
  cluster: string;
  region: string;
  associates: number;
  workedDays: number;
  salary: number;
  deliveries: number;
  customerReturns: number;
  shipments: number;
  pendingDays: number;
  cps: number | null;
  days: FixedPayDaDay[];
  people: FixedPayDaPersonDay[];
};

export type FixedPayLocation = {
  id: string;
  station_code: string;
  station_name?: string | null;
  city?: string | null;
  region?: string | null;
  cluster_manager?: string | null;
  aom?: string | null;
};

/** Fixed/MG rupees only — never fold package pay, fuel, van or Adhoc into this report. */
export function fixedPaySalary(detail: Pick<CpsDaDetail, "salary">) {
  return Number(detail.salary) || 0;
}

export function fixedPayShipments(detail: Pick<CpsDaDetail, "deliveries" | "customer_returns">) {
  return cpsShipmentCount(Number(detail.deliveries) || 0, Number(detail.customer_returns) || 0);
}

/** Pending attendance must not blank the station CPS — use known complete amounts. */
export function fixedPayCps(salary: number, shipments: number) {
  return shipments > 0 ? salary / shipments : null;
}

export function clusterLabelFor(location: FixedPayLocation) {
  return String(location.cluster_manager || location.aom || "Unassigned").trim() || "Unassigned";
}

export function projectFixedPayDaStations(
  locations: FixedPayLocation[],
  details: CpsDaDetail[]
): FixedPayDaStation[] {
  const byStation = new Map<string, CpsDaDetail[]>();
  for (const detail of details) {
    if (detail.cohort !== "guarantee") continue;
    if (fixedPaySalary(detail) <= 0 && fixedPayShipments(detail) <= 0 && !(detail.pending_fixed_dates?.length)) {
      continue;
    }
    const list = byStation.get(detail.station_code) ?? [];
    list.push(detail);
    byStation.set(detail.station_code, list);
  }

  return locations.map((location) => {
    const peopleDetails = byStation.get(location.station_code) ?? [];
    const people: FixedPayDaPersonDay[] = peopleDetails.map((detail) => ({
      workerId: detail.worker_id,
      dropxId: detail.dropx_id,
      name: detail.name,
      providerIds: detail.provider_ids,
      salary: fixedPaySalary(detail),
      deliveries: Number(detail.deliveries) || 0,
      customerReturns: Number(detail.customer_returns) || 0,
      shipments: fixedPayShipments(detail),
      pendingFixedDates: detail.pending_fixed_dates ?? [],
      workDates: detail.work_dates
    }));

    const dayMap = new Map<string, FixedPayDaDay>();
    for (const detail of peopleDetails) {
      const dates = detail.cost_dates.length ? detail.cost_dates : detail.work_dates;
      const daySalary = dates.length ? fixedPaySalary(detail) / dates.length : 0;
      const dayDeliveries = detail.work_dates.length
        ? (Number(detail.deliveries) || 0) / detail.work_dates.length
        : 0;
      const dayReturns = detail.work_dates.length
        ? (Number(detail.customer_returns) || 0) / detail.work_dates.length
        : 0;
      for (const date of dates) {
        const worked = detail.work_dates.includes(date);
        const existing = dayMap.get(date) ?? {
          date,
          associates: 0,
          salary: 0,
          deliveries: 0,
          customerReturns: 0,
          shipments: 0,
          pendingDays: 0,
          cps: null,
          people: []
        };
        existing.associates += 1;
        existing.salary += daySalary;
        if (worked) {
          existing.deliveries += dayDeliveries;
          existing.customerReturns += dayReturns;
        }
        if (detail.pending_fixed_dates?.includes(date)) existing.pendingDays += 1;
        existing.people.push({
          workerId: detail.worker_id,
          dropxId: detail.dropx_id,
          name: detail.name,
          providerIds: detail.provider_ids,
          salary: daySalary,
          deliveries: worked ? dayDeliveries : 0,
          customerReturns: worked ? dayReturns : 0,
          shipments: worked ? cpsShipmentCount(dayDeliveries, dayReturns) : 0,
          pendingFixedDates: detail.pending_fixed_dates?.includes(date) ? [date] : [],
          workDates: worked ? [date] : []
        });
        dayMap.set(date, existing);
      }
    }

    const days = [...dayMap.values()]
      .map((day) => {
        const shipments = cpsShipmentCount(day.deliveries, day.customerReturns);
        return { ...day, shipments, cps: fixedPayCps(day.salary, shipments) };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    const salary = people.reduce((sum, person) => sum + person.salary, 0);
    const deliveries = people.reduce((sum, person) => sum + person.deliveries, 0);
    const customerReturns = people.reduce((sum, person) => sum + person.customerReturns, 0);
    const shipments = cpsShipmentCount(deliveries, customerReturns);
    const pendingDays = people.reduce((sum, person) => sum + person.pendingFixedDates.length, 0);
    const workedDays = new Set(people.flatMap((person) => person.workDates)).size;

    return {
      id: location.id,
      code: location.station_code,
      name: location.station_name || location.city || location.station_code,
      cluster: clusterLabelFor(location),
      region: location.region || "Unassigned",
      associates: people.length,
      workedDays,
      salary,
      deliveries,
      customerReturns,
      shipments,
      pendingDays,
      cps: fixedPayCps(salary, shipments),
      days,
      people
    };
  });
}
