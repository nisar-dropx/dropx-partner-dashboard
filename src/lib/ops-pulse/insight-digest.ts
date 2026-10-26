import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DigestBuilder, DigestControl } from '../portal-digest-delivery';
import { loadNowMailScope, nowDigestEvents } from '../amazon-now-digest';
import { allRoutingRows, loadPeopleReviewGraph } from './people-review-routing';
import { resolveStoreReviewLeaders } from './people-review-route';
import { storeInsightFacts } from './insight-facts';
import { generateInsightBrief } from './insight-editor';
import { renderInsightEmail, type InsightFact } from './insight-email';
import { mapWithConcurrency } from '../bounded-concurrency';
import { loadReviewAttendanceHistory } from './review-attendance-history-data';
import { summarizeAssistantAttendance } from './assistant-attendance';
export const insightEvents=['now_insight_morning','now_insight_evening'] as const;
export type InsightEvent=typeof insightEvents[number];
export function defaultInsightControl(company:string,event:InsightEvent):DigestControl{return {company_id:company,portal:'ops',event_key:event,state:'disabled',paused_until:null,subject_template:'DropX · Dark Store insights | {{month}} {{year}}',config:{schedule_time:event==='now_insight_morning'?'09:00':'18:00',timezone:'Asia/Kolkata',day_offset:0,thread_mode:'monthly',delivery_window_minutes:90,delivery_ready:false,editorial_brief:'Crisp store-level evidence, a win when supported, the biggest operational risk, and an actionable next move. Rotate focus while following up unresolved issues.',accent:'#e65124',character_enabled:true,topics:['health','activities','attendance']}};}
/** Always inherit the current existing report recipient configuration; no extra recipient list or expanded scope. */
export async function loadInsightScope(db:SupabaseClient,control:DigestControl){
 const controls=await db.from('portal_notification_controls').select('*').eq('company_id',control.company_id).eq('portal','ops').in('event_key',[...nowDigestEvents]);
 if(controls.error||!controls.data?.length)throw Error('Existing Dark Store report recipients are unavailable.');
 const scopes=await Promise.all(controls.data.map(c=>loadNowMailScope(db,c as DigestControl)));
 const stations=[...new Map(scopes.flatMap(s=>s.stations).map(s=>[s.id,s])).values()];
 const recipients=new Map<string,{email:string;name:string;stationIds:string[]}>();
 for(const scope of scopes)for(const r of scope.recipients){const old=recipients.get(r.email);recipients.set(r.email,{...r,stationIds:[...new Set([...(old?.stationIds||[]),...r.stationIds])]});}
 return {stations,recipients:[...recipients.values()]};
}
export async function buildInsightDigest(db:SupabaseClient,control:DigestControl,date:string,preview?:{email:string;stationIds:string[]}) {
 const scope=await loadInsightScope(db,control);
 if(preview){scope.recipients=scope.recipients.filter(r=>r.email===preview.email).map(r=>({...r,stationIds:r.stationIds.filter(id=>preview.stationIds.includes(id))})).filter(r=>r.stationIds.length);scope.stations=scope.stations.filter(s=>scope.recipients.some(r=>r.stationIds.includes(s.id)));}
 if(!scope.stations.length||!scope.recipients.length)throw Error('No eligible Dark Store insight recipients.');
 const topics=Array.isArray(control.config.topics)?control.config.topics.map(String):['health','activities','attendance'];
 const ids=scope.stations.map(s=>s.id),codes=scope.stations.map(s=>s.station_code),from=new Date(Date.parse(date)-14*86400000).toISOString().slice(0,10),to=new Date(Date.parse(date)-86400000).toISOString().slice(0,10);
 const query=(table:string,select:string)=>db.from(table).select(select).eq('company_id',control.company_id);
 const [health,shifts,days,actions,graph,prior]=await Promise.all([
  allRoutingRows(query('report_metric_facts','station_code,report_date,values_json,created_at').eq('source_type','qc_store_health_daily').in('station_code',codes).gte('report_date',from).lte('report_date',to).order('created_at',{ascending:false}).order('id')),
  allRoutingRows(query('ops_si_shift_checklists','location_id,shift_date,status').in('location_id',ids).is('deleted_at',null).lte('shift_date',to).in('status',['open','submitted','rejected']).order('id')),
  allRoutingRows(query('ops_store_ops_checklists','location_id,work_date,status').in('location_id',ids).is('deleted_at',null).lte('work_date',to).eq('status','open').order('id')),
  allRoutingRows(query('ops_performance_followups','station_id,title,owner_label,due_date,status').in('station_id',ids).lt('due_date',date).not('status','in','(done,closed,completed,cancelled)').order('id')),
  loadPeopleReviewGraph(control.company_id,db),
  query('portal_digest_deliveries','recipient_email,scope_summary,report_date').eq('portal','ops').in('event_key',[...insightEvents]).eq('status','accepted').gte('report_date',from).order('report_date',{ascending:false}).limit(300)
 ]);
 if(prior.error)throw Error('Previous insight editions could not be checked.');
 const stores=scope.stations.map(s=>({...s,owner:resolveStoreReviewLeaders(graph,s.id).map(p=>`${p.name} · ${p.role}`).join(', ')||'Store leadership assignment needs checking'}));
 let facts=storeInsightFacts(stores,health,{shifts,days,actions},date).filter(f=>topics.includes(['Shift handover','Store routines','Follow-through'].includes(f.topic)?'activities':'health'));
 if(topics.includes('attendance')){
  const weekFrom=new Date(Date.parse(to)-6*86400000).toISOString().slice(0,10);
  const attendanceFacts=await mapWithConcurrency(stores,3,async store=>{
   try{
    const history=await loadReviewAttendanceHistory(control.company_id,store,to,{from:weekFrom});
    const summary=summarizeAssistantAttendance([history],weekFrom,to,{role:'picker'}),n=summary.totals;
    const pct=n.reported?Math.round((n.reported-n.late)/n.reported*1000)/10:null;
    return {id:`${store.id}:attendance`,topic:'Picker punctuality',storeCode:store.station_code,storeName:store.station_name||'',city:store.city||'',owner:store.owner,label:'On time among verified reported shifts',value:pct===null?'Not enough evidence':`${pct}%`,detail:`${n.reported-n.late} on time / ${n.reported} reported working shifts; ${n.unresolved} unresolved days. ${n.people} pickers assigned at period end. Excludes leave and off days. Missing records are not absence.`,period:`${weekFrom} to ${to}`,href:'/ops-pulse?view=manpower',sentiment:n.unresolved?'attention':'neutral'} as InsightFact;
   }catch{return {id:`${store.id}:attendance-unavailable`,topic:'Data coverage',storeCode:store.station_code,storeName:store.station_name||'',value:'Attendance check unavailable',label:'Picker punctuality',detail:'The source could not be verified for this edition. Do not infer performance.',period:`${weekFrom} to ${to}`,href:'/ops-pulse?view=manpower',sentiment:'neutral'} as InsightFact;}
  });facts.push(...attendanceFacts);
 }
 const edition=control.event_key==='now_insight_morning'?'Morning focus':'Evening follow-through';
 const groups=[...new Set(scope.recipients.map(r=>[...r.stationIds].sort().join(',')))];
 if(groups.length>25)throw Error('Insight audience exceeds this run’s safe generation limit.');
 const briefByScope=new Map<string,Awaited<ReturnType<typeof generateInsightBrief>>>();
 await mapWithConcurrency(groups,3,async key=>{
  const allowed=new Set(key.split(',')),selected=facts.filter(f=>scope.stations.some(s=>s.station_code===f.storeCode&&allowed.has(s.id)));
  if(!selected.length)throw Error('No evidence for a recipient scope.');
  const emails=new Set(scope.recipients.filter(r=>[...r.stationIds].sort().join(',')===key).map(r=>r.email));
  const titles=((prior.data||[]) as unknown as {recipient_email:string;scope_summary:any}[]).filter(p=>emails.has(p.recipient_email)).flatMap(p=>Array.isArray(p.scope_summary?.insightTitles)?p.scope_summary.insightTitles:[]);
  briefByScope.set(key,await generateInsightBrief(selected,edition,String(control.config.editorial_brief||''),titles));
 });
 const checkedAt=new Date().toISOString();
 const month=new Intl.DateTimeFormat('en-IN',{month:'long',year:'numeric',timeZone:'Asia/Kolkata'}).format(new Date(date+'T12:00:00+05:30'));
 return {checkedAt,messages:scope.recipients.map(r=>{const key=[...r.stationIds].sort().join(','),brief=briefByScope.get(key)!;const selected=facts.filter(f=>scope.stations.some(s=>r.stationIds.includes(s.id)&&s.station_code===f.storeCode));return {email:r.email,name:r.name,subject:(control.subject_template||defaultInsightControl(control.company_id,control.event_key as InsightEvent).subject_template!).replaceAll('{{month}}',month.replace(/ \d{4}$/,'')).replaceAll('{{year}}',date.slice(0,4)),...renderInsightEmail({name:r.name,date,edition,checkedAt,facts:selected,brief,accent:String(control.config.accent||''),character:control.config.character_enabled!==false,stores:scope.stations.filter(s=>r.stationIds.includes(s.id)).map(s=>s.station_code)}),scope:{stationIds:r.stationIds,insightTitles:brief.cards.map(c=>c.title),factIds:brief.cards.flatMap(c=>c.factIds),edition}};})};
};
