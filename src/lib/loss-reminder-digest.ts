import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {DigestBuilder} from './portal-digest-delivery';
import {readAllRows} from './supabase-pagination';
import {loadPeopleOperationalHierarchy} from './people-operational-hierarchy';
import {nlPeopleClusters} from './ops-pulse/nl-loss-clusters';
import {lossReminderStage,lossReminderScheduleTime,lossReminderInWindow,selectLossReminderRows,type ReminderStation,type ReminderCase,type ReminderPlan,type ReminderRequest,type ReminderRedispute} from './loss-reminder-policy';
import {renderLossReminder} from './loss-reminder-render';

type Recipient={email:string;name:string;stationIds:string[]};
export async function loadLossReminderScope(db:SupabaseClient,company:string,config:Record<string,unknown>){
 const [stationResult,aliases,memberships,roles]=await Promise.all([
  readAllRows(db.from('stations').select('id,station_code,station_name').eq('company_id',company).order('id')),
  readAllRows(db.from('cod_station_settings').select('location_id,portal_station_code').eq('company_id',company).order('location_id')),
  readAllRows(db.from('company_product_memberships').select('user_id,role_id,location_scope_ids,has_all_location_access,profiles!company_product_memberships_user_id_fkey!inner(id,email,full_name,is_active)').eq('company_id',company).eq('product_code','operations').eq('is_active',true).order('user_id')),
  db.from('user_roles').select('id,code').eq('company_id',company).eq('is_active',true),
 ]);
 if([stationResult,aliases,memberships,roles].some(r=>r.error))throw Error('Loss reminder recipient scope could not be loaded completely.');
 const codes=new Map((aliases.data||[]).map(a=>[a.location_id,a.portal_station_code]));
 const hierarchy=await loadPeopleOperationalHierarchy(company,(stationResult.data||[]).map(s=>s.id),{includeStationResponsibilities:true});
 if(hierarchy.error)throw Error('Loss station ownership is unavailable.');
 const clusters=nlPeopleClusters(stationResult.data||[],hierarchy.byLocation);
 const stations:ReminderStation[]=(stationResult.data||[]).map(s=>({...s,source_code:String(codes.get(s.id)||s.station_code).trim().toUpperCase(),cluster:clusters.byStation.get(s.id)?.cluster||'Not mapped'}));
 const roleCodes=new Map((roles.data||[]).map(r=>[r.id,String(r.code).toUpperCase()]));
 const allowed=new Set(['OPERATIONS_LOCATION','OPERATIONS_CLM','OPERATIONS_CM','OPERATIONS_AOM','OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_FINMGR','OPERATIONS_MP','OPERATIONS_CT']);
 const extra=new Set((Array.isArray(config.additional_recipient_emails)?config.additional_recipient_emails:[]).map(e=>String(e).trim().toLowerCase()));
 const ids=new Set(stations.map(s=>s.id)),recipients=new Map<string,Recipient>();
 for(const m of memberships.data||[]){
  const p=Array.isArray(m.profiles)?m.profiles[0]:m.profiles;
  const email=String(p?.email||'').trim().toLowerCase(),role=roleCodes.get(m.role_id)||'';
  if(!p?.is_active||!email.endsWith('@'+String(config.email_domain||'').toLowerCase())||(!allowed.has(role)&&!extra.has(email)))continue;
  const stationIds=m.has_all_location_access?[...ids]:(m.location_scope_ids||[]).filter((id:string)=>ids.has(id));
  if(!stationIds.length)continue;
  const existing=recipients.get(email);
  recipients.set(email,{email,name:p.full_name||email,stationIds:[...new Set([...(existing?.stationIds||[]),...stationIds])]});
 }
 return {stations,recipients:[...recipients.values()]};
}
export async function loadLossReminderData(db:SupabaseClient,company:string,stations:ReminderStation[]){
 const checkedAt=new Date().toISOString();
 const [cases,plans,requests,redisputes,settings,...runs]=await Promise.all([
  readAllRows(db.from('nl_loss_month_cases').select('month,case_key,report,station_code,amount,source_present,source_status,data_source,final_seen_at,lifecycle_status,last_seen_at,source_updated_at,details').eq('company_id',company).in('report',['nl','slp']).order('month').order('case_key')),
  readAllRows(db.from('nl_loss_recoveries').select('month,case_key,is_deleted,approval_status,source_amount,source_status,outcome_code,recovery_details,allocations').eq('company_id',company).eq('is_deleted',false).order('month').order('case_key')),
  readAllRows(db.from('nl_dispute_requests').select('month,case_key,status,source_stage').eq('company_id',company).order('month').order('case_key')),
  readAllRows(db.from('nl_case_response_windows').select('month,case_key,enabled,workflow_status').eq('company_id',company).order('month').order('case_key')),
  db.from('nl_loss_sources').select('recoverable_statuses').eq('company_id',company).single(),
  ...['nl','slp_final'].map(report=>db.from('loss_report_runs').select('checked_at,finished_at,status').eq('report',report).in('status',['completed','failed']).order('started_at',{ascending:false}).limit(1).maybeSingle()),
 ]);
 if([cases,plans,requests,redisputes,settings,...runs].some(r=>r.error))throw Error('Loss reminder source query failed; no incomplete email was queued.');
 const warnings:string[]=[];
 runs.forEach((r,i)=>{const at=r.data?.checked_at||r.data?.finished_at,name=i?'SLP Final':'NL';if(!at||r.data?.status==='failed'||Date.now()-Date.parse(at)>86400000)warnings.push(`${name}: source refresh needs attention; these are the latest stored records.`);});
 const scoped=new Set(stations.map(s=>s.source_code));
 const records=(cases.data||[]) as ReminderCase[];
 if(records.some(c=>scoped.has(c.station_code)&&c.source_present&&(c.amount===null||!Number.isFinite(Number(c.amount)))))throw Error('A loss amount is missing. Resolve source data before sending totals.');
 return {checkedAt,warnings,input:{stations,cases:records,plans:(plans.data||[]) as ReminderPlan[],requests:(requests.data||[]) as ReminderRequest[],redisputes:(redisputes.data||[]) as ReminderRedispute[],recoverableStatuses:settings.data?.recoverable_statuses||[]}};
}
export const buildLossReminderDigest:DigestBuilder=async(db,control,date)=>{
 const stage=lossReminderStage(control.event_key);
 if(!stage||!lossReminderInWindow(stage,date))return {checkedAt:new Date().toISOString(),messages:[]};
 const scope=await loadLossReminderScope(db,control.company_id,control.config);
 const data=await loadLossReminderData(db,control.company_id,scope.stations);
 const rows=selectLossReminderRows(stage,data.input);
 const messages=scope.recipients.flatMap(recipient=>{
  const scopedRows=rows.filter(r=>recipient.stationIds.includes(r.stationId));
  if(!scopedRows.some(r=>r.pending))return [];
  const r=renderLossReminder({stage,event:control.event_key,date,scheduledTime:lossReminderScheduleTime(control.event_key,date,control.config),rows:scopedRows,checkedAt:data.checkedAt,warnings:data.warnings});
  return [{email:recipient.email,name:recipient.name,subject:r.subject,html:r.html,text:r.text,attachments:[r.attachment],scope:{stationIds:r.stationIds,stage,reportDate:date,count:r.pending}}];
 });
 return {checkedAt:data.checkedAt,messages};
};
