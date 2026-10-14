import type { OpsStationManpowerPerson } from './station-manpower';

export function summarizeStoreCpu(rows: {units:number|null; cost:number; days:number; through:string|null; provisional?:boolean}[]) {
  const ready=rows.filter(r=>r.units!==null && r.units>0 && r.days>0 && r.through!==null);
  const sameCutoff=new Set(ready.map(r=>r.through)).size===1;
  const hasCostGaps=rows.some(r=>r.provisional);
  const complete=ready.length===rows.length && rows.length>0 && sameCutoff && !hasCostGaps;
  const cost=ready.reduce((n,r)=>n+r.cost,0), units=ready.reduce((n,r)=>n+r.units!,0);
  return {ready:ready.length,complete,cost,units,hasCostGaps,cpu:complete?cost/units:null,through:complete?ready[0].through:null};
}

export function summarizeStorePeople(people: OpsStationManpowerPerson[], now: number) {
  const summary = { active: people.length, reported: 0, working: 0, completed: 0, due: 0, dueReported: 0, notReported: 0, upcoming: 0, off: 0, leave: 0, unplanned: 0, missingOut: 0 };
  for (const p of people) {
    const t = p.today;
    if (t.reported) summary.reported++;
    if (p.availability === 'Working') summary.working++;
    if (p.availability === 'Completed') summary.completed++;
    if (t.approvedLeave || p.availability === 'On leave') { summary.leave++; continue; }
    if (p.availability === 'Roster off') { summary.off++; continue; }
    const start = t.shiftStartsAt ? Date.parse(t.shiftStartsAt) : NaN;
    if (!Number.isFinite(start)) { summary.unplanned++; continue; }
    if (start > now) { summary.upcoming++; continue; }
    summary.due++;
    if (t.reported) summary.dueReported++; else summary.notReported++;
    // An open punch during the shift is normal, not a missing punch-out.
    if (t.reported && t.missingPunch && t.shiftEndsAt && Date.parse(t.shiftEndsAt) < now) summary.missingOut++;
  }
  return summary;
}

export type DsUnitRecord = { station_code: string; month: string; through_date: string; units: number | string };
export function summarizeStoreUnits(record: DsUnitRecord | undefined, through: string) {
  if (!record) return { units: null, through: null, upd: null, status: 'missing' as const };
  const units = Number(record.units), days = Number(record.through_date.slice(8));
  if (!Number.isFinite(units) || units < 0 || days < 1) return { units: null, through: null, upd: null, status: 'missing' as const };
  return { units, through: record.through_date, upd: units / days, status: record.through_date < through ? 'behind' as const : 'current' as const };
}
