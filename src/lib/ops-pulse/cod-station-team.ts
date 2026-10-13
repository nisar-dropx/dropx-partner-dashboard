import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { loadPeopleOperationalHierarchy } from '@/lib/people-operational-hierarchy';
import { codStatusToday } from './cod-status';
import { teamShift, type CodTeamPerson, type TeamRosterRow } from './cod-station-team-core';
import { isRosterPlanActiveOn } from '@/lib/roster-plan-preference';

/** Contact-only projection from active People engagements and current assignments. */
export async function loadCodTeamDirectory(companyId:string, locationIds:string[], managerPersonIds:string[]=[], asOf=codStatusToday()) {
  if(!supabaseAdmin) throw Error('People unavailable.');
  if(!locationIds.length) return [] as CodTeamPerson[];
  const db=supabaseAdmin;
  const results=await Promise.all([
    readAllRows(db.from('hr_work_assignments').select('id,engagement_id,location_id,designation_id,position_title,effective_from').eq('company_id',companyId).eq('is_primary',true).lte('effective_from',asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).order('effective_from',{ascending:false}).order('id')),
    readAllRows(db.from('hr_engagements').select('id,person_id,worker_type,employee_id,contractor_id').eq('company_id',companyId).eq('status','active').lte('start_date',asOf).or(`end_date.is.null,end_date.gte.${asOf}`).order('id')),
    readAllRows(db.from('hr_people').select('id,display_name').eq('company_id',companyId).eq('status','active').order('id')),
    readAllRows(db.from('designations').select('id,code,name').eq('company_id',companyId).eq('is_active',true).order('id'))
  ]);
  for(const result of results) if(result.error) throw Error(result.error.message);
  const [assignments,engagements,people,designations]=results.map(result=>result.data ?? []);
  const engagementById=new Map(engagements.map(row=>[row.id,row]));
  const personById=new Map(people.map(row=>[row.id,row]));
  const designationById=new Map(designations.map(row=>[row.id,row]));
  const seen=new Set<string>();
  const candidates=assignments.flatMap(row=>{
    // Resolve the current assignment before station scope, so transfers cannot
    // expose an obsolete posting left open in People.
    if(seen.has(row.engagement_id)) return [];
    seen.add(row.engagement_id);
    const e=engagementById.get(row.engagement_id),p=e && personById.get(e.person_id);
    if(!e || !p || (!locationIds.includes(row.location_id) && !managerPersonIds.includes(p.id))) return [];
    const d=designationById.get(row.designation_id);
    const workerType=e.worker_type==='employee'?'employee':e.contractor_id?'contractor':null;
    const workerId=workerType==='employee'?e.employee_id:e.contractor_id;
    if(!workerType || !workerId) return [];
    return [{personId:p.id,name:p.display_name,role:d?.name || row.position_title || 'Role not set',roleCode:d?.code || '',workerId,workerType,locationId:row.location_id,manager:managerPersonIds.includes(p.id),phone:null} satisfies CodTeamPerson];
  });
  const contacts=await Promise.all(['employee','contractor'].map(async type=>{
    const ids=candidates.filter(p=>p.workerType===type).map(p=>p.workerId);
    if(!ids.length) return {data:[],error:null};
    return readAllRows(db.from(type==='employee'?'employees':'contractors').select('id,mobile,mobile_country_code').eq('company_id',companyId).eq('is_active',true).is('deleted_at',null).not('people_lifecycle_status','in','("offboarding","offboarded")').in('id',ids).order('id'));
  }));
  for(const result of contacts) if(result.error) throw Error(result.error.message);
  const contactById=new Map<string,{mobile?:string|null;mobile_country_code?:string|null}>(contacts.flatMap((result,index)=>(result.data??[]).map(row=>[`${index===0?'employee':'contractor'}:${row.id}`,row] as const)));
  const distinct=new Set<string>();
  return candidates.flatMap((person):CodTeamPerson[]=>{
    const contact=contactById.get(`${person.workerType}:${person.workerId}`);
    if(!contact || distinct.has(person.personId)) return [];
    distinct.add(person.personId);
    const phone=String(contact.mobile || '').trim();
    const country=String(contact.mobile_country_code || '').replace(/\D/g,'');
    return [{...person,phone:phone?(country && !phone.startsWith('+')?`+${country} ${phone}`:phone):null}];
  }).sort((a,b)=>Number(b.manager)-Number(a.manager) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}

export async function loadCodStationTeam(companyId:string,locationId:string) {
  const asOf=codStatusToday();
  const hierarchy=await loadPeopleOperationalHierarchy(companyId,[locationId],{includeStationResponsibilities:true});
  if(hierarchy.error) throw Error(hierarchy.error);
  const station=hierarchy.byLocation.get(locationId);
  const managerIds=[...new Set([...(station?.clusterManagers??[]),...(station?.areaOperationsManagers??[])].map(person=>person.personId))];
  const people=await loadCodTeamDirectory(companyId,[locationId],managerIds,asOf);
  if(!people.length) return {asOf,people};
  if(!supabaseAdmin) throw Error('Rosters unavailable.');
  const plans=await readAllRows(supabaseAdmin.from('hr_roster_plans').select('id,status,roster_kind,effective_from,superseded_at,revision_no,updated_at').eq('company_id',companyId).eq('status','approved').lte('effective_from',asOf).order('id'));
  if(plans.error) throw Error(plans.error.message);
  const active=(plans.data??[]).filter(plan=>isRosterPlanActiveOn(plan,asOf));
  const byId=new Map(active.map(plan=>[plan.id,plan]));
  const entries=active.length?await readAllRows(supabaseAdmin.from('hr_roster_entries').select('plan_id,worker_type,worker_id,roster_date,day_type,hr_shifts(name,start_time,end_time)').eq('company_id',companyId).in('worker_id',people.map(p=>p.workerId)).in('plan_id',active.map(p=>p.id)).order('id')):{data:[],error:null};
  if(entries.error) throw Error(entries.error.message);
  const rows:TeamRosterRow[]=(entries.data??[]).map(row=>({...row,plan:byId.get(row.plan_id)!,shift:Array.isArray(row.hr_shifts)?row.hr_shifts[0]:row.hr_shifts}));
  return {asOf,people:people.map(person=>({...person,shift:teamShift(person,rows,asOf)}))};
}
