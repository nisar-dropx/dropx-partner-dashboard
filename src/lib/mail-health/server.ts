import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import defaults from './defaults.json';
import { base, discover, evaluate, localParts, shiftDate, validateSource, type Catalog, type Source, type Entry, type Health } from './model';
const eventKey='mail_health_registry';
export type Registry={version:number;sources:Record<string,Partial<Source>>};
export type Snapshot={checkedAt:string;health:Health[];warnings:string[];watchdogAt:string|null;history:unknown[]};
let schemaCache:{at:number;data:Catalog}|undefined;
function db(){if(!supabaseAdmin)throw new Error('Mail monitoring database is not configured.');return supabaseAdmin;}
export async function catalog():Promise<Catalog>{
 if(schemaCache&&Date.now()-schemaCache.at<300000)return schemaCache.data;
 const response=await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`,{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY!,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,Accept:'application/openapi+json'},cache:'no-store',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Mail source discovery unavailable (${response.status}).`);
 const schema=await response.json();
 const data:Catalog=Object.fromEntries(Object.entries(schema.definitions??schema.components?.schemas??{}).map(([k,v])=>[k,(v as {properties?:Catalog[string]}).properties??{}]));
 if(!Object.keys(data).length)throw new Error('Mail source discovery returned no schema.');
 schemaCache={at:Date.now(),data};return data;
}
async function registry(companyId:string){
 const result=await db().from('portal_notification_controls').select('config,updated_at').eq('company_id',companyId).eq('portal','dashboard').eq('event_key',eventKey).maybeSingle();
 if(result.error)throw new Error('Mail Health settings could not be read.');
 return {config:(result.data?.config??defaults) as Registry,revision:result.data?.updated_at??null};
}
async function paged(table:string,select:string,companyId:string,apply:(q:any)=>any,cap=2000):Promise<{rows:any[];partial:boolean}>{
 const rows:any[]=[];
 for(let from=0;from<cap;from+=250){
  const result=await apply(db().from(table).select(select).eq('company_id',companyId)).range(from,from+249);
  if(result.error)throw new Error(`${table}: ${result.error.message}`);
  rows.push(...result.data??[]);if((result.data??[]).length<250)return {rows,partial:false};
 }
 return {rows,partial:true};
}
const identifier=/^[a-z][a-z0-9_]*$/;
const safeError=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,300);
async function settings(source:Source,schema:Catalog){
 if(!source.settings)return source;
 const ref=source.settings,cols=schema[ref.table];
 if(!cols?.company_id||!/(settings|templates)$/.test(ref.table))throw new Error('Linked schedule settings are unavailable.');
 const paths=[ref.enabled,ref.time,ref.start].filter((v):v is string=>!!v);
 const fields=[...new Set(paths.map(v=>v.split('.')[0]))];
 if(fields.some(f=>!identifier.test(f)||!cols[f]||/(pass|secret|token|smtp)/i.test(f)))throw new Error('Invalid schedule settings fields.');
 return {source,ref,fields};
}
function pathValue(row:any,path?:string){return path?.split('.').reduce((v,k)=>v?.[k],row);}
async function readSource(companyId:string,original:Source,schema:Catalog,now:Date):Promise<Health>{
 let source={...original};const warnings:string[]=[];
 try{
  const linked=await settings(source,schema);
  if('fields' in linked){
   const response=await db().from(linked.ref.table).select(linked.fields.join(',')).eq('company_id',companyId).limit(2);
   if(response.error||response.data?.length!==1)throw new Error('The linked schedule could not be uniquely resolved.');
   const row=response.data[0];source.enabled=source.enabled&&pathValue(row,linked.ref.enabled)===true;
   if(linked.ref.time){const t=pathValue(row,linked.ref.time);if(typeof t!=='string'||!/^\d{2}:\d{2}/.test(t))throw new Error('Source schedule time is missing.');source.time=t.slice(0,5);}
   if(linked.ref.start)source.startDate=pathValue(row,linked.ref.start);
  }
  const cols=schema[source.table];
  if(!cols?.company_id)throw new Error('Company-scoped delivery ledger is unavailable.');
  const fields=[...new Set(['id',source.statusField,source.timeField,source.dateField,source.recipientField,source.errorField].filter((v):v is string=>!!v))];
  if(fields.some(f=>!identifier.test(f)||!cols[f]||/(body|html|subject|secret|pass|token)/i.test(f)))throw new Error('Delivery metadata fields are unavailable.');
  const filter=(q:any)=>{for(const [key,value] of Object.entries(source.filters??{})){if(!identifier.test(key)||!cols[key])throw new Error('Source filter is invalid.');q=q.eq(key,value);}return q;};
  const since=new Date(now.getTime()-9*86400000).toISOString();
  const recent=await paged(source.table,fields.join(','),companyId,q=>filter(q).gte(source.dateField??source.timeField,source.dateField?since.slice(0,10):since).order(source.timeField,{ascending:false,nullsFirst:false}).order('id'));
  const blocked=await paged(source.table,fields.join(','),companyId,q=>filter(q).in(source.statusField,['uncertain','needs_review','sending','queued','pending']).order(source.timeField,{ascending:true,nullsFirst:true}).order('id'),500);
  if(recent.partial||blocked.partial)warnings.push('Result limit reached. Coverage is partial; narrow or investigate this source.');
  const unique=new Map([...recent.rows,...blocked.rows].map(row=>[String(row.id),row]));
  const entries:Entry[]=[...unique.values()].map(row=>{
   const at=row[source.timeField]?String(row[source.timeField]):null;
   return {id:String(row.id),status:String(row[source.statusField]??'unknown').toLowerCase(),at,date:source.dateField?String(row[source.dateField]??''):at?localParts(new Date(at),source.timezone).date:null,recipient:source.recipientField?String(row[source.recipientField]??''):'See source record',error:source.errorField?String(row[source.errorField]??'').slice(0,300):''};
  });
  let run: {date:string;count:number}|undefined;
  if(source.table==='portal_digest_deliveries'){
   const due=evaluate(source,[],now).dueDate;
   if(due){const result=await db().from('portal_digest_runs').select('report_date,recipient_count').eq('company_id',companyId).eq('portal',source.filters!.portal).eq('event_key',source.filters!.event_key).eq('report_date',due).maybeSingle();
    if(result.error)warnings.push('Expected recipient count could not be read.');else if(result.data)run={date:result.data.report_date,count:result.data.recipient_count};}
  }
  return evaluate(source,entries,now,run,warnings);
 }catch(error){const health=evaluate({...source,mode:'setup',timezone:'UTC'},[],now,undefined,[safeError(error)]);return {...health,source};}
}
export async function snapshot(companyId:string):Promise<Snapshot>{
 const now=new Date(),warnings:string[]=[];
 const [schemaResult,registryResult,controls,heartbeat]=await Promise.allSettled([
  catalog(),registry(companyId),
  paged('portal_notification_controls','portal,event_key,state,paused_until,config',companyId,q=>q.order('portal').order('event_key')),
  db().from('people_web_notifications').select('data').eq('company_id',companyId).eq('event_code','mail_health_monitor').order('created_at',{ascending:false}).limit(1)
 ]);
 const schema=schemaResult.status==='fulfilled'?schemaResult.value:{};
 if(schemaResult.status==='rejected')warnings.push(safeError(schemaResult.reason));
 const config=registryResult.status==='fulfilled'?registryResult.value.config:defaults as Registry;
 if(registryResult.status==='rejected')warnings.push(safeError(registryResult.reason));
 const sources=discover(schema).filter(s=>s.table!=='portal_digest_deliveries').map(s=>({...s,...config.sources[s.key],key:s.key,table:s.table}));
 if(controls.status==='fulfilled'){
  if(controls.value.partial)warnings.push('Notification control discovery is partial.');
  for(const c of controls.value.rows){
   if(c.event_key.startsWith('mail_health_'))continue;
   const cfg=c.config??{},key=`${c.portal}:${c.event_key}`;
   // Shared controls are discovered without a portal/event allowlist.
   sources.push({...base,key,table:'portal_digest_deliveries',label:c.event_key.replaceAll('_',' '),portal:c.portal,...config.sources[key],mode:cfg.schedule_time?'daily':'event',time:String(cfg.schedule_time??'14:00'),timezone:cfg.timezone??base.timezone,dayOffset:Number(cfg.day_offset??0),startDate:cfg.first_report_date?shiftDate(cfg.first_report_date,-Number(cfg.day_offset??0)):undefined,endDate:cfg.last_report_date?shiftDate(cfg.last_report_date,-Number(cfg.day_offset??0)):undefined,statusField:'status',timeField:'started_at',dateField:'report_date',recipientField:'recipient_email',errorField:'error',filters:{portal:c.portal,event_key:c.event_key},control:{state:c.state,pausedUntil:c.paused_until,ready:cfg.delivery_ready===true}});
  }
 }else warnings.push('Shared notification controls could not be discovered.');
 const health:Health[]=[];
 // Bound concurrency so mail monitoring cannot saturate the operational database.
 for(let i=0;i<sources.length;i+=4)health.push(...await Promise.all(sources.slice(i,i+4).map(s=>readSource(companyId,s,schema,now))));
 if(!sources.length)warnings.push('No mail sources could be verified. This does not mean all mail is healthy.');
 const h=heartbeat.status==='fulfilled'?heartbeat.value:null;
 if(h?.error||heartbeat.status==='rejected')warnings.push('Watchdog heartbeat could not be read.');
 return {checkedAt:now.toISOString(),health,warnings,watchdogAt:h?.data?.[0]?.data?.checkedAt??null,history:[]};
}
export async function configuration(companyId:string){
 const [settings,schema,audit]=await Promise.all([registry(companyId),catalog(),db().from('portal_notification_control_audit').select('id,actor_id,created_at,before_data,after_data').eq('company_id',companyId).eq('portal','dashboard').eq('event_key',eventKey).order('created_at',{ascending:false}).limit(20)]);
 if(audit.error)throw new Error('Configuration change history could not be loaded.');
 const ids=[...new Set((audit.data??[]).map(a=>a.actor_id).filter(Boolean))];
 const actors=ids.length?await db().from('profiles').select('id,full_name').eq('company_id',companyId).in('id',ids):{data:[],error:null};
 const names=new Map((actors.data??[]).map(p=>[p.id,p.full_name]));
 return {...settings,available:discover(schema),history:(audit.data??[]).map(a=>({...a,actorName:names.get(a.actor_id)??a.actor_id??'System'}))};
}
export async function saveSource(companyId:string,userId:string,input:Source,revision:string|null){
 const [existing,schema]=await Promise.all([registry(companyId),catalog()]);
 validateSource(input,schema);
 if(existing.revision!==revision)throw new Error('Settings changed in another session. Refresh before saving.');
 const editable:Partial<Source>={label:input.label.trim(),portal:input.portal.trim(),owner:input.owner.trim(),mode:input.mode,time:input.time,timezone:input.timezone,graceMinutes:input.graceMinutes,queueMinutes:input.queueMinutes,dayOffset:input.dayOffset,startDate:input.startDate,...(!input.settings&&!input.control?{enabled:input.enabled}:{})};
 const config={...existing.config,sources:{...existing.config.sources,[input.key]:{...existing.config.sources[input.key],...editable}}};
 const row={company_id:companyId,portal:'dashboard',event_key:eventKey,config,updated_by:userId,updated_at:new Date().toISOString(),state:'enabled'};
 if(revision){const result=await db().from('portal_notification_controls').update(row).eq('company_id',companyId).eq('portal','dashboard').eq('event_key',eventKey).eq('updated_at',revision).select('updated_at');if(result.error||!result.data?.length)throw new Error('Settings changed or could not be saved. Refresh and retry.');}
 else{const result=await db().from('portal_notification_controls').insert(row);if(result.error)throw new Error('Settings could not be created. Refresh and retry.');}
}
export async function runWatchdog(){
 const companies=await db().from('companies').select('id').order('id').limit(500);
 if(companies.error||companies.data?.length===500)throw new Error('Company discovery is incomplete.');
 const results=[];
 for(const company of companies.data??[]){
  const data=await snapshot(company.id);
  const roles=await db().from('user_roles').select('id').eq('company_id',company.id).eq('code','OWNER');
  if(roles.error)throw new Error('Watchdog alert owner roles could not be resolved.');
  const roleIds=(roles.data??[]).map(r=>r.id);
  const profiles=await db().from('profiles').select('id').eq('company_id',company.id).eq('is_active',true).or(roleIds.length?`is_master_owner.eq.true,role_id.in.(${roleIds.join(',')})`:'is_master_owner.eq.true').limit(100);
  if(profiles.error||profiles.data?.length===100)throw new Error('Watchdog alert owners could not be completely resolved.');
  const owners=profiles.data??[];
  const issues=data.health.filter(h=>['attention','unknown'].includes(h.state));
  const summary={checkedAt:data.checkedAt,issues:issues.length,setup:data.health.filter(h=>h.state==='setup').length,sources:data.health.length,warnings:data.warnings,items:issues.map(h=>({key:h.source.key,label:h.source.label,state:h.state,message:h.message,owner:h.source.owner}))};
  if(!owners.length){results.push({companyId:company.id,error:'No active company owner can receive the watchdog alert.'});continue;}
  const rows=owners.map(owner=>({company_id:company.id,recipient_user_id:owner.id,event_code:'mail_health_monitor',source_key:'latest',title:issues.length?'Mail Health needs attention':'Mail Health check',body:`${issues.length} streams need attention; ${summary.setup} need setup.`,href:'/notifications/mail-health',data:summary,created_at:data.checkedAt}));
  const saved=await db().from('people_web_notifications').upsert(rows,{onConflict:'company_id,event_code,source_key,recipient_user_id'});
  if(saved.error)throw new Error('Watchdog check could not be recorded.');
  results.push({companyId:company.id,sources:summary.sources,issues:summary.issues,setup:summary.setup,warnings:data.warnings,checks:data.health.map(h=>({source:h.source.key,state:h.state,warnings:h.warnings}))});
 }
 return results;
}
export async function latestHeartbeat(companyId:string){
 const result=await db().from('people_web_notifications').select('data').eq('company_id',companyId).eq('event_code','mail_health_monitor').order('created_at',{ascending:false}).limit(1);
 if(result.error)throw new Error('Watchdog heartbeat unavailable.');return result.data?.[0]?.data??null;
}
