export type VolumeDay = { date: string; inbound: number | null; delivered: number | null; deliverySource: string; inboundUnverified?: number };
export type PaymentVolume = {
  station: string; date: string; today: string; todayInbound: number | null;
  requireDestination?: boolean; groupStations?: string[]; breakup?: Array<{station:string;inbound:number}>; unallocated?: number;
  days: VolumeDay[]; baseline: number | null; baselineDays: number; difference: number | null;
  snapshotAt: string | null; refreshedAt: string; latestInboundSnapshot?: string | null;
  bulky: number | null; classified: number; packages: number; routingVerified: number;
  vehicles: Array<{ id: string; number: string; model: string; source: string; partner: string; status: string; operational: boolean; deployed: boolean; location: string }>;
  fleetError: string | null; sizeRule: SizeRule | null;
};
export function dateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function shiftDay(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function volumeBaseline(days: VolumeDay[], date: string) {
  const matches = [7, 14, 21, 28].map(offset => days.find(day => day.date === shiftDay(date, -offset)))
    .filter((day): day is VolumeDay & { inbound: number } => day?.inbound != null);
  // Incomplete matching weekdays must not masquerade as a normal four-week baseline.
  const baseline = matches.length === 4 ? matches.reduce((sum, day) => sum + day.inbound, 0) / 4 : null;
  const current = days.find(day => day.date === date)?.inbound;
  return { baseline, baselineDays: matches.length, difference: baseline != null && baseline > 0 && current != null ? (current - baseline) / baseline * 100 : null };
}
export function highVolumeContext(head: string | null | undefined, answers: Array<{ answer_value: string | null; payment_head_questions?: { question_text: string } | null }>) {
  if (head !== 'VAN_ADHOC') return null;
  const reason = answers.find(a => /reason.*(?:adhoc|ad hoc).*deployment/i.test(a.payment_head_questions?.question_text ?? ''))?.answer_value?.trim().toLowerCase();
  const date = answers.find(a => /^deployment date$/i.test(a.payment_head_questions?.question_text?.trim() ?? ''))?.answer_value ?? '';
  return reason === 'high volume' && dateKey(date) ? date : null;
}
export type SizeRule = { maxLengthCm: number; maxWidthCm: number; maxHeightCm: number; maxWeightKg: number; dimensionalDivisor: number; maxDimensionalWeightKg: number };
export type SizeFact = { actual_weight_kg: number | null; length_cm: number | null; width_cm: number | null; height_cm: number | null; cubic_volume_cm3: number | null };
export function shipmentSize(fact: SizeFact, rule: SizeRule | null): 'bulky' | 'small' | 'unknown' {
  if (!rule || ![rule.maxLengthCm, rule.maxWidthCm, rule.maxHeightCm, rule.maxWeightKg, rule.dimensionalDivisor, rule.maxDimensionalWeightKg].every(n => Number.isFinite(Number(n)) && Number(n) > 0)) return 'unknown';
  const values = [fact.actual_weight_kg, fact.length_cm, fact.width_cm, fact.height_cm, fact.cubic_volume_cm3 == null ? null : fact.cubic_volume_cm3 / rule.dimensionalDivisor];
  const limits = [rule.maxWeightKg, rule.maxLengthCm, rule.maxWidthCm, rule.maxHeightCm, rule.maxDimensionalWeightKg];
  if (values.some((n, i) => n != null && n > limits[i])) return 'bulky';
  return values.every(n => n != null && Number(n) > 0) ? 'small' : 'unknown';
}

// Recorded receiving-hub totals are not evidence of the serving station.
export function verifiedInbound(rows: Array<{ package_count: number | string | null; raw_payload: { serving_station_code?: string } | null }>, station: string) {
  let matched = 0, unverified = 0;
  for (const row of rows) {
    const count = Math.max(1, Number(row.package_count) || 1);
    const destination = row.raw_payload?.serving_station_code?.trim().toUpperCase();
    if (!destination) unverified += count;
    else if (destination === station) matched += count;
  }
  return { inbound: rows.length && !unverified ? matched : null, unverified };
}

export function adhocApprovalContext(head:string|null|undefined,answers:Array<{answer_value:string|null;payment_head_questions?:{question_text:string}|null}>){
 if(head!=='VAN_ADHOC')return null;
 const date=answers.find(a=>/^deployment date$/i.test(a.payment_head_questions?.question_text?.trim()??''))?.answer_value??'';
 return dateKey(date)?date:null;
}

export type RoutedInbound = { tracking_id: string; station_code: string; snapshot_at: string; package_count: number | string | null; raw_payload: {serving_station_code?:string;dock_arrival_date?:string}|null };
export function groupedInbound(rows:RoutedInbound[],stations:string[],requireDestination=true,requireDockArrival=false) {
 // Once manifest dates exist, delivery-promise rows cannot inflate the same day.
 const dockRows=rows.filter(row=>Boolean(row.raw_payload?.dock_arrival_date));
 const arrivalRows=requireDockArrival||dockRows.length?dockRows:rows;
 const latest=new Map<string,RoutedInbound>();
 for(const row of arrivalRows){const old=latest.get(row.tracking_id);if(!old||row.snapshot_at>old.snapshot_at||(row.snapshot_at===old.snapshot_at&&!old.raw_payload?.serving_station_code&&row.raw_payload?.serving_station_code))latest.set(row.tracking_id,row);}
 const unique=[...latest.values()];
 if(stations.length===1 && requireDestination){const result=verifiedInbound(unique,stations[0]);return {...result,breakup:[{station:stations[0],inbound:result.inbound??0}],unallocated:0,accepted:unique.filter(r=>r.raw_payload?.serving_station_code===stations[0])};}
 const counts=new Map(stations.map(s=>[s,0]));let unallocated=0;const accepted:RoutedInbound[]=[];
 for(const row of unique){const destination=row.raw_payload?.serving_station_code?.trim().toUpperCase();const count=Math.max(1,Number(row.package_count)||1);
 if(destination&&!counts.has(destination))continue;
 if(destination)counts.set(destination,(counts.get(destination)||0)+count);else unallocated+=count;
 accepted.push(row);
 }
 return {inbound:unique.length?[...counts.values()].reduce((a,b)=>a+b,0)+unallocated:null,unverified:0,breakup:[...counts].map(([station,inbound])=>({station,inbound})),unallocated,accepted};
}
