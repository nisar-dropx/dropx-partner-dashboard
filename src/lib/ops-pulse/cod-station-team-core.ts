import { preferActiveRosterRow, formatShiftClock, type RosterPlanPreference } from '../roster-plan-preference.ts';
export type CodTeamPerson = {personId:string;name:string;role:string;roleCode:string;phone:string|null;workerId:string;workerType:string;locationId:string|null;manager:boolean;shift?:string};
export type CodStationTeam = {asOf:string;people:CodTeamPerson[]};
export function isStationLead(person:Pick<CodTeamPerson,'roleCode'|'role'>) {
  return ['TL','ATL','STM'].includes(person.roleCode.toUpperCase()) || /\b(team lead(?:er)?|station manager|hub incharge)\b/i.test(person.role);
}
export type TeamRosterRow = {worker_id:string;worker_type:string;roster_date:string;day_type:string;plan:RosterPlanPreference;shift:{name:string;start_time:string;end_time:string}|null};
export function teamShift(person:Pick<CodTeamPerson,'workerId'|'workerType'>,rows:TeamRosterRow[],asOf:string) {
  const weekday=(day:string)=>new Date(day+'T00:00:00Z').getUTCDay();
  const applicable=rows.filter(row=>row.worker_id===person.workerId && row.worker_type===person.workerType && (row.plan.roster_kind==='recurring_weekly'?weekday(row.roster_date)===weekday(asOf):row.roster_date===asOf));
  const row=preferActiveRosterRow(applicable,asOf,r=>r.plan);
  if(!row) return 'Shift not rostered';
  if(row.day_type!=='working') return row.day_type.replace(/_/g,' ');
  if(!row.shift) return 'Shift not set';
  const {name,start_time,end_time}=row.shift;
  return `${name} · ${formatShiftClock(start_time)}–${formatShiftClock(end_time)}${end_time<=start_time?' (+1 day)':''} IST`;
}
