import type { CpsSnapshot } from "./cps";
import type { CpsRate } from "./cps-details";

type Row = Record<string, any>;
export type ReviewAssociatePay = {
  associateId: string; providerIds: string[]; name: string; delivered: number;
  assigned: number | null; deliveryRate: number | null; paymentScheme: string | null;
  paymentSetupStatus: string | null; rateCard: string | null; rates: CpsRate[];
  totalPay: number | null; costStatus: string | null; cpsShipments: number | null;
  associateCps: number | null; stationCpsImpact: number | null;
  mtdActiveDays: number; mtdDelivered: number;
  mtdDailyAllocations: { date: string; delivered: number }[];
};
const key = (value: unknown) => String(value ?? "").trim().toUpperCase();
const number = (value: unknown) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const relation = (value: any) => Array.isArray(value) ? value[0] : value;
const activeOn = (mapping: Row, date: string) => ["active", "closed"].includes(mapping.status)
  && mapping.effective_from <= date && (!mapping.effective_to || mapping.effective_to >= date);

// Presentation of saved rate amounts only. All cost/attendance/proration maths
// remains in the shared CPS engine, not a second Review Desk payroll calculator.
export function reviewMappingRates(mapping: Row, components: Row[]): CpsRate[] {
  const values = new Map(Object.entries(mapping.payment_values ?? {}).map(([code, value]) => [key(code), value]));
  const result: CpsRate[] = [];
  for (const component of components.filter(c => c.payment_method_id === mapping.payment_method_id)) {
    const field = relation(component.payment_fields) ?? {};
    const code = key(component.component_code || field.code);
    const rate = number(values.get(code));
    if (rate == null || rate < 0) continue;
    const production = component.component_type === "production" || field.calculation_type === "count_x_rate";
    const source = field.provider_calculation_sources?.amazon || field.calculation_source || code;
    const schedule = field.pay_schedule || component.pay_schedule || (field.calculation_type === "fixed_monthly" ? "per month" : "");
    result.push({ label: field.label || component.label || field.name || code.replaceAll("_", " "), rate,
      basis: String(production ? source : schedule || "fixed amount").replaceAll("_", " ").toLowerCase() });
  }
  if (!result.length && !mapping.payment_method_id) {
    for (const [field, label, basis] of [["delivery_rate", "Delivery", "per delivery"],
      ["guarantee_amount", "Minimum guarantee", mapping.guarantee_schedule || "per day"],
      ["fuel_rate", "Fuel", "per delivery"]]) {
      const rate = number(mapping[field]);
      if (rate != null) result.push({ label, rate, basis });
    }
  }
  return result;
}

export function buildReviewAssociatePay(input: {
  date: string; stations: { id: string; station_code: string }[];
  details: Row[]; shipments: Row[]; mappings: Row[]; components: Row[];
  links: Row[]; scc: Row[]; snapshot: CpsSnapshot | null; error?: string | null;
}) {
  const stationIds = new Map(input.stations.map(s => [key(s.station_code), s.id]));
  const mappingCache = new Map<string, Row[]>();
  const mappingsFor = (station: string, date: string) => {
    const cacheKey = `${key(station)}|${date}`;
    let mappings = mappingCache.get(cacheKey);
    if (!mappings) {
      mappings = input.mappings.filter(m => m.station_id === stationIds.get(key(station)) && activeOn(m, date));
      mappingCache.set(cacheKey, mappings);
    }
    return mappings;
  };
  // IDs, never names. Reject conflicting evidence in either direction. Resolve
  // each historical day's mapping independently so transfers do not rewrite MTD.
  const identity = (station: string, date: string, rawId: string) => {
    const id = key(rawId), candidates = new Set<string>();
    const mappings = mappingsFor(station, date);
    const providerIds = new Set([id]), transporterIds = new Set([id]);
    let conflict = false;
    for (const snapshot of input.scc.filter(s => s.station_id === stationIds.get(key(station)))) {
      const age = Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.parse(snapshot.observed_at));
      if (!Number.isFinite(age) || age > 7 * 86400000) continue;
      const drivers: Row[] = Array.isArray(snapshot.drivers) ? snapshot.drivers : [];
      const matches = drivers.filter(d => key(d.tasId) === id || key(d.employeeId) === id);
      for (const match of matches) {
        const forward = new Set(drivers.filter(d => key(d.employeeId) === key(match.employeeId)).map(d => key(d.tasId)));
        const reverse = new Set(drivers.filter(d => key(d.tasId) === key(match.tasId)).map(d => key(d.employeeId)));
        if (forward.size !== 1 || reverse.size !== 1) conflict = true;
        providerIds.add(key(match.employeeId));
        transporterIds.add(key(match.tasId));
      }
    }
    for (const mapping of mappings) if (providerIds.has(key(mapping.provider_member_id)) && mapping.workforce_id) candidates.add(mapping.workforce_id);
    for (const link of input.links) if (transporterIds.has(key(link.transporter_id)) && mappings.some(m => m.workforce_id === link.workforce_id)) candidates.add(link.workforce_id);
    for (const detail of input.snapshot?.da_details ?? []) if (date === input.date && key(detail.station_code) === key(station)
      && detail.provider_ids.some(providerId => providerIds.has(key(providerId)))) candidates.add(detail.worker_id);
    if (conflict || candidates.size > 1) return { id: `unresolved:${id}`, workerId: null, conflict: true };
    const workerId = [...candidates][0] ?? null;
    // An exact SCC link can still merge an unmapped pair without inventing a pay mapping.
    return { id: workerId ? `worker:${workerId}` : `provider:${[...providerIds].sort()[0]}`, workerId, conflict: false };
  };
  const identityCache = new Map<string, ReturnType<typeof identity>>();
  type Mutable = ReviewAssociatePay & { workerId: string | null; detailDays: Map<string, number>; shipmentDays: Map<string, number>; conflict: boolean };
  const groups = new Map<string, Map<string, Mutable>>();
  const get = (station: string, date: string, id: string, name: string, forcedWorker?: string) => {
    station = key(station);
    if (!stationIds.has(station)) return null;
    const identityKey = `${station}|${date}|${key(id)}`;
    let resolved = identityCache.get(identityKey);
    if (forcedWorker) resolved = { id: `worker:${forcedWorker}`, workerId: forcedWorker, conflict: false };
    else if (!resolved) {
      resolved = identity(station, date, id);
      identityCache.set(identityKey, resolved);
    }
    const people = groups.get(station) ?? new Map<string, Mutable>();
    const person: Mutable = people.get(resolved.id) ?? {
      associateId: id, providerIds: [], name: name || id || "Unidentified associate", delivered: 0,
      assigned: null, deliveryRate: null, paymentScheme: null, paymentSetupStatus: null, rateCard: null,
      totalPay: null, costStatus: null, cpsShipments: null, associateCps: null, stationCpsImpact: null,
      rates: [], mtdActiveDays: 0, mtdDelivered: 0, mtdDailyAllocations: [],
      workerId: resolved.workerId, conflict: resolved.conflict, detailDays: new Map(), shipmentDays: new Map(),
    };
    if (id && !person.providerIds.includes(id)) person.providerIds.push(id);
    people.set(resolved.id, person); groups.set(station, people);
    return person;
  };
  const validDate = (date: string) => date >= `${input.date.slice(0, 7)}-01` && date <= input.date;
  for (const row of input.details) {
    const date = row.work_date;
    if (!validDate(date) || !row.driver_id) continue;
    const person = get(row.station_code, date, row.driver_id, row.driver_name);
    if (!person) continue;
    person.detailDays.set(date, (person.detailDays.get(date) ?? 0) + (number(row.package_count) ?? 1));
  }
  for (const row of input.shipments) {
    const date = row.work_date;
    if (!validDate(date) || !row.provider_employee_id) continue;
    const person = get(row.station_code, date, row.provider_employee_id, row.dropx_name || row.provider_employee_name);
    if (!person) continue;
    person.shipmentDays.set(date, (person.shipmentDays.get(date) ?? 0) + (number(row.total_delivery) ?? 0));
    if (date === input.date && number(row.assigned_count) != null) person.assigned = (person.assigned ?? 0) + Number(row.assigned_count);
  }
  for (const detail of input.snapshot?.da_details ?? []) {
    if (!detail.cost_dates.includes(input.date)) continue;
    const person = get(detail.station_code, input.date, detail.provider_ids[0] || detail.dropx_id, detail.name, detail.worker_id);
    if (!person) continue;
    person.associateId = detail.dropx_id || person.associateId;
    person.name = detail.name || person.name;
    for (const id of detail.provider_ids) if (!person.providerIds.includes(id)) person.providerIds.push(id);
    person.totalPay = (person.totalPay ?? 0) + detail.salary + detail.variable + detail.fuel;
    person.cpsShipments = (person.cpsShipments ?? 0) + detail.deliveries + detail.customer_returns;
    if (detail.pending_fixed_dates?.includes(input.date)) person.costStatus = "Cost pending: attendance, input or mapping needs review";
    person.rates.push(...detail.periods.flatMap(period => period.rates));
  }
  const result = new Map<string, ReviewAssociatePay[]>();
  for (const [station, people] of groups) {
    const day = input.snapshot?.daily.find(d => key(d.station_code) === station && d.work_date === input.date);
    const stationShipments = day ? day.deliveries + day.c_return : 0;
    const rows: ReviewAssociatePay[] = [];
    for (const person of people.values()) {
      const dates = new Set([...person.detailDays.keys(), ...person.shipmentDays.keys()]);
      person.mtdDailyAllocations = [...dates].map(date => ({ date,
        delivered: person.detailDays.get(date) ?? person.shipmentDays.get(date) ?? 0
      })).filter(d => d.delivered > 0).sort((a, b) => b.date.localeCompare(a.date));
      person.delivered = person.detailDays.get(input.date) ?? person.shipmentDays.get(input.date) ?? 0;
      person.mtdDelivered = person.mtdDailyAllocations.reduce((sum, d) => sum + d.delivered, 0);
      person.mtdActiveDays = person.mtdDailyAllocations.length;
      if (person.delivered <= 0 && (person.totalPay ?? 0) <= 0 && person.cpsShipments == null) continue;
      const mappings = mappingsFor(station, input.date).filter(m => m.workforce_id && m.workforce_id === person.workerId);
      const calculatedSchemes = (input.snapshot?.associates ?? []).filter(row => key(row.station_code) === station
        && row.work_date === input.date && person.providerIds.some(id => key(id) === key(row.provider_employee_id)))
        .map(row => row.pay_type?.replaceAll("_", " ")).filter(Boolean);
      person.paymentScheme = [...new Set(mappings.map(m => relation(m.payment_methods)?.name || m.pay_type).filter(Boolean))].join(" / ")
        || [...new Set(calculatedSchemes)].join(" / ") || null;
      if (!person.rates.length) person.rates = mappings.flatMap(m => reviewMappingRates(m, input.components));
      person.rates = [...new Map(person.rates.map(rate => [JSON.stringify(rate), rate])).values()];
      person.deliveryRate = person.rates.find(r => /^(per )?(amazon )?delivery$/.test(r.basis))?.rate ?? null;
      person.rateCard = person.rates.map(r => `${r.label}: ₹${r.rate.toLocaleString("en-IN")} / ${r.basis}`).join(" · ") || null;
      person.paymentSetupStatus = person.conflict ? "Identity conflict — check ID mapping" : mappings.length || person.totalPay != null ? "Mapped" : "No verified payment mapping for this date";
      person.costStatus ||= input.error || (person.totalPay == null ? "Cost unavailable — check identity or payment mapping" : null);
      // Unknown or partial cost must never appear as zero CPS.
      if (!person.costStatus && person.totalPay != null) {
        person.associateCps = (person.cpsShipments ?? 0) > 0 ? person.totalPay / person.cpsShipments! : null;
        person.stationCpsImpact = stationShipments > 0 ? person.totalPay / stationShipments : null;
      }
      const { workerId, detailDays, shipmentDays, conflict, ...publicRow } = person;
      rows.push(publicRow);
    }
    result.set(station, rows.sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name)));
  }
  return result;
}
