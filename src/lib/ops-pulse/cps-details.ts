import type { CpsSnapshot } from "./cps";

export type CpsRate = { label: string; rate: number; basis: string };
export type CpsProductionDetail = {
  label: string; basis: string; rate: number; reported_units: number;
  payable_units: number; threshold_units: number; amount: number; bucket: string;
};
export type CpsDaDay = {
  worker_id: string; dropx_id: string; name: string; station_code: string; date: string;
  provider_ids: string[]; cohort: "variable" | "guarantee"; worked: boolean;
  work_basis: "attendance" | "shipment activity" | "no work evidence";
  deliveries: number; customer_returns: number; seller_pickups: number; seller_returns: number;
  salary: number; variable: number; fuel: number; van: number;
  card_from: string; rates: CpsRate[]; source: string;
  production_details?: CpsProductionDetail[];
  pending_fixed_pay?: boolean;
};
export type CpsDaPeriod = {
  from: string; to: string; card_from: string; rates: CpsRate[]; source: string;
  deliveries: number; customer_returns: number; seller_pickups: number; seller_returns: number;
  salary: number; variable: number; fuel: number; van: number;
  production_details?: CpsProductionDetail[];
};
export type CpsDaDetail = Omit<CpsDaDay, "date" | "worked" | "work_basis" | "card_from" | "rates" | "source" | "pending_fixed_pay" | "production_details"> & {
  work_dates: string[]; cost_dates: string[]; work_bases: string[]; periods: CpsDaPeriod[];
  pending_fixed_dates?: string[];
};
const amounts = ["deliveries", "customer_returns", "seller_pickups", "seller_returns", "salary", "variable", "fuel", "van"] as const;
// One identity may have multiple provider IDs. Days are distinct and salary is
// already allocated once by the engine; this projection never recalculates pay.
export function summarizeDaDetails(days: CpsDaDay[]): CpsDaDetail[] {
  const groups = new Map<string, CpsDaDetail>();
  for (const d of days) {
    const k = `${d.worker_id}|${d.station_code}|${d.cohort}`;
    let g = groups.get(k);
    if (!g) {
      g = { worker_id:d.worker_id, dropx_id:d.dropx_id, name:d.name, station_code:d.station_code,
        cohort:d.cohort, provider_ids:[], work_dates:[], cost_dates:[], work_bases:[], periods:[],
        deliveries:0, customer_returns:0, seller_pickups:0, seller_returns:0, salary:0, variable:0, fuel:0, van:0 };
      groups.set(k,g);
    }
    for (const field of amounts) g[field] += d[field];
    if (d.pending_fixed_pay) g.pending_fixed_dates = [...new Set([...(g.pending_fixed_dates ?? []), d.date])];
    for (const id of d.provider_ids) if (id && !g.provider_ids.includes(id)) g.provider_ids.push(id);
    if (d.worked && !g.work_dates.includes(d.date)) g.work_dates.push(d.date);
    if (!g.cost_dates.includes(d.date)) g.cost_dates.push(d.date);
    if (d.worked && !g.work_bases.includes(d.work_basis)) g.work_bases.push(d.work_basis);
    let period = g.periods.find(p => p.source===d.source && p.card_from===d.card_from && JSON.stringify(p.rates)===JSON.stringify(d.rates));
    if (!period) {
      period={from:d.date,to:d.date,card_from:d.card_from,rates:d.rates,source:d.source,deliveries:0,customer_returns:0,seller_pickups:0,seller_returns:0,salary:0,variable:0,fuel:0,van:0};
      g.periods.push(period);
    }
    period.from=period.from<d.date?period.from:d.date; period.to=period.to>d.date?period.to:d.date;
    for (const field of amounts) period[field]+=d[field];
    for (const component of d.production_details ?? []) {
      const components = period.production_details ??= [];
      const existing = components.find(c => c.label === component.label && c.basis === component.basis && c.rate === component.rate && c.bucket === component.bucket);
      if (existing) {
        existing.reported_units += component.reported_units;
        existing.payable_units += component.payable_units;
        existing.threshold_units += component.threshold_units;
        existing.amount += component.amount;
      } else components.push({ ...component });
    }
  }
  return [...groups.values()].sort((a,b)=>(b.salary+b.variable+b.fuel)-(a.salary+a.variable+a.fuel));
}
export function daCohortTotals(rows: CpsDaDetail[], cohort: CpsDaDay["cohort"]) {
  const people=rows.filter(r=>r.cohort===cohort);
  const amount=people.reduce((n,r)=>n+r.salary+r.variable+r.fuel,0);
  const deliveries=people.reduce((n,r)=>n+r.deliveries,0);
  const pending = people.some(p => p.pending_fixed_dates?.length);
  return {people, amount, deliveries, pending, cps:!pending && deliveries>0?amount/deliveries:null};
}
export function cpsFuelTrend(snapshot: CpsSnapshot) {
  const dates=[...new Set(snapshot.daily.map(d=>d.work_date))].sort();
  return dates.map(date=>{
    const sources=new Map<string,number>();
    for(const line of snapshot.breakup) if(line.work_date===date && /fuel|diesel|petrol/i.test(line.sub_head)) {
      const label=`${line.head} · ${line.sub_head}`;
      sources.set(label,(sources.get(label)??0)+Number(line.amount));
    }
    const amount=[...sources.values()].reduce((n,v)=>n+v,0);
    const deliveries=snapshot.daily.filter(d=>d.work_date===date).reduce((n,d)=>n+d.deliveries,0);
    return {date,amount,deliveries,cps:deliveries>0?amount/deliveries:null,sources:[...sources].map(([label,amount])=>({label,amount}))};
  });
}
