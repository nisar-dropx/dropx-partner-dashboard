import type {SupabaseClient} from '@supabase/supabase-js';
import type {DARow,DAOwner,DASetup} from './da-onboarding-registry';
import {allClientIdRows} from './workforce-client-id-queue';
export type SetupMapping={id:string;workforce_id:string|null;field_executive_id:string|null;contractor_id:string|null;employee_id:string|null;station_id:string;provider_member_id:string;effective_from:string;effective_to:string|null;status:string;payment_method_id:string|null;payment_values:Record<string,unknown>|null};
export function mappingBelongsTo(m:SetupMapping,o:DAOwner){
 if(m.workforce_id)return m.workforce_id===o.id;
 return Boolean(o.source_profile_id&&({field_executive:m.field_executive_id,employee:m.employee_id,contractor:m.contractor_id} as Record<string,string|null>)[o.source_profile_type||'']===o.source_profile_id);
}
export function currentSetupMappings(rows:SetupMapping[],o:DAOwner,station:string,date:string){return rows.filter(m=>mappingBelongsTo(m,o)&&m.station_id===station&&['active','closed'].includes(m.status)&&m.effective_from<=date&&(!m.effective_to||m.effective_to>=date));}
export function savedRateCard(m:Pick<SetupMapping,'payment_method_id'|'payment_values'>){return Boolean(m.payment_method_id&&m.payment_values&&Object.keys(m.payment_values).length);}
/** Only compact, company/station scoped configuration. No payout calculation on opening the queue. */
export async function loadDASetup(db:SupabaseClient,company:string,station:string,rows:DARow[]){
 const date=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),checkedAt=new Date().toISOString();
 const owners=rows.flatMap(r=>r.owner?[r.owner]:[]),keys=new Map<string,Set<string>>([['workforce_id',new Set(owners.map(o=>o.id))]]);
 for(const o of owners){const column=({field_executive:'field_executive_id',contractor:'contractor_id',employee:'employee_id'} as Record<string,string>)[o.source_profile_type||''];if(column&&o.source_profile_id){if(!keys.has(column))keys.set(column,new Set());keys.get(column)!.add(o.source_profile_id);}}
 const mappings=new Map<string,SetupMapping>();
 for(const [column,values] of keys){const ids=[...values];for(let start=0;start<ids.length;start+=100){const data=await allClientIdRows<SetupMapping>((from,to)=>db.from('field_executive_provider_mappings').select('id,workforce_id,field_executive_id,employee_id,contractor_id,station_id,provider_member_id,effective_from,effective_to,status,payment_method_id,payment_values').eq('company_id',company).eq('station_id',station).in('status',['active','closed']).lte('effective_from',date).in(column,ids.slice(start,start+100)).order('id').range(from,to));for(const m of data)mappings.set(m.id,m);}}
 const direct=new Set<string>();
 for(let start=0;start<owners.length;start+=100){const data=await allClientIdRows<{workforce_id:string;effective_to:string|null;payment_method_id:string|null;payment_values:Record<string,unknown>|null}>((from,to)=>db.from('workforce_payment_allocations').select('id,workforce_id,effective_to,payment_method_id,payment_values').eq('company_id',company).eq('station_id',station).in('workforce_id',owners.slice(start,start+100).map(o=>o.id)).in('status',['active','closed']).lte('effective_from',date).order('id').range(from,to));for(const a of data)if((!a.effective_to||a.effective_to>=date)&&savedRateCard(a))direct.add(a.workforce_id);}
 for(const row of rows){const current=row.owner?currentSetupMappings([...mappings.values()],row.owner,station,date):[];row.setup={mapping:row.conflict?'unknown':row.owner?.provider_employee_id||current.some(m=>m.provider_member_id?.trim())?'confirmed':'pending',rateCard:current.some(savedRateCard)||Boolean(row.owner&&direct.has(row.owner.id))?'configured':'pending',checkedAt};}
}
export type SetupMilestone={id:string;label:string;state:'complete'|'pending'|'review'|'unknown';detail:string};
export function setupMilestones(row:DARow):SetupMilestone[]{
 const reg=row.owner?.onboarding_status||row.guided?.registration||'pending';
 const registered=['active','approved','confirmed'].includes(reg),review=['under_review','submitted'].includes(reg);
 return [
  {id:'registration',label:'Registration',state:registered?'complete':review?'review':'pending',detail:registered?'Registration approved':review?'Submitted · team review pending':reg==='returned'||reg==='rejected'?'Corrections requested':'Associate needs to fill required details'},
  {id:'dropx_id',label:'DropX ID',state:row.owner?.dropx_id?'complete':'pending',detail:row.owner?.dropx_id||'Created after identity confirmation'},
  {id:'activation',label:'DropX activation',state:row.status==='ACTIVE'?'complete':row.status==='INACTIVE'||row.status==='OFFBOARDED'?'review':'pending',detail:row.status==='ACTIVE'?'Active in DropX':row.status==='ONBOARDING'?'Registration and activation review pending':row.status.toLowerCase()},
  {id:'mapping',label:'ID mapping',state:row.conflict?'review':row.setup?.mapping==='confirmed'?'complete':row.setup?.mapping==='pending'?'pending':'unknown',detail:row.conflict?'Conflicting identity · team review required':row.setup?.mapping==='confirmed'?'Provider payroll ID linked to this DropX ID':row.setup?.mapping==='pending'?'Awaiting a confirmed provider payroll ID':'Mapping source not checked'},
  {id:'rate_card',label:'Rate card',state:row.setup?.rateCard==='configured'?'complete':row.setup?.rateCard==='pending'?'pending':'unknown',detail:row.setup?.rateCard==='configured'?'Current payment method and values saved':row.setup?.rateCard==='pending'?'Team: configure payment method, rates and effective dates':'Payment configuration not checked'}
 ];
}
