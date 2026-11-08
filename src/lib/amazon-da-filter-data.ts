import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {AmazonDaList,AmazonDaMilestone,AmazonBgcStatus} from './amazon-da-desk-types';
import {callWorkforceAmazonWorker} from './workforce-amazon-worker';
import {pendingMilestones,type DeskPerson} from './amazon-da-filters';

type Source={rows:DeskPerson[];checkedAt:string;snapshot:string;warnings:string[];incomplete?:boolean};
const cache=new Map<string,{at:number;value:Promise<Source>}>();
/** The insufficiency inbox must never wait for every associate at every station. */
export async function loadAmazonRequestSource(companyId:string,stationIds:string[],fresh=false):Promise<Source>{
 if(!stationIds.length)return {rows:[],checkedAt:new Date().toISOString(),snapshot:'empty',warnings:[]};
 const ids=[...new Set(stationIds)].sort(),key=`requests:${companyId}:${ids.join(',')}`;
 const saved=cache.get(key);if(!fresh&&saved&&Date.now()-saved.at<30_000)return saved.value;
 const value=(async()=>{
  const result=await callWorkforceAmazonWorker<{rows:DeskPerson[];checkedAt:string}>('/api/admin/amazon/station-desk/idfy-queue',{method:'POST',body:JSON.stringify({companyId,stationIds:ids,fresh}),signal:AbortSignal.timeout(110_000)});
  if(!Array.isArray(result.rows)||result.rows.some(p=>!p.stationId||!ids.includes(p.stationId)))throw Error('IDfy request scope could not be verified. Refresh to retry.');
  return {rows:result.rows,checkedAt:result.checkedAt,snapshot:createHash('sha256').update(JSON.stringify(result.rows)).digest('hex'),warnings:[]};
 })();
 for(const [k,v] of cache)if(Date.now()-v.at>=30_000)cache.delete(k);
 if(cache.size>=64)cache.delete(cache.keys().next().value!);
 cache.set(key,{at:Date.now(),value});value.then(()=>{const current=cache.get(key);if(current?.value===value)current.at=Date.now();},()=>{if(cache.get(key)?.value===value)cache.delete(key);});return value;
}
/** Call only after current company/station authorization. Filter complete rosters on
 * the server; return only the requested page and compact dependent choices. No
 * per-person browser calls are triggered by opening or filtering this list. */
export async function loadAmazonFilterSource(db:SupabaseClient,companyId:string,stationId:string,view:string,fresh=false):Promise<Source>{
 const group=view.startsWith('bgc')?'current':view;
 const key=`${companyId}:${stationId}:${group}`;
 const saved=cache.get(key);if(!fresh&&saved&&Date.now()-saved.at<30_000)return saved.value;
 const value=(async()=>{
  const times:string[]=[];
  async function roster(sourceView:string):Promise<DeskPerson[]>{
   for(let retry=0;retry<2;retry++){
    const rows:DeskPerson[]=[];let offset=0,snapshot='',restart=false;
    for(let page=0;page<100;page++){
     const result=await callWorkforceAmazonWorker<AmazonDaList>('/api/admin/amazon/station-desk/list',{method:'POST',body:JSON.stringify({companyId,stationId,view:sourceView,pageSize:100,offset,snapshot,fresh:fresh&&page===0})});
     if(!Array.isArray(result.rows))throw Error('Amazon roster could not be checked. Refresh to retry.');
     if(result.reset){restart=true;break;}
     rows.push(...result.rows);if(result.checkedAt)times.push(result.checkedAt);
     if(result.nextOffset==null)return rows;
     if(result.nextOffset<=offset)throw Error('Amazon pagination did not advance.');
     offset=result.nextOffset;snapshot=result.snapshot;
    }
    if(!restart)throw Error('Amazon roster is too large to filter safely.');
   }throw Error('Amazon roster changed while loading. Refresh to retry.');
  }
  const groups=await Promise.all((group==='current'?['onboarding','associates']:[group]).map(roster));
  const rows=[...new Map(groups.flat().map(p=>[p.providerId,{...p}])).values()];
  const warnings:string[]=[];
  // Read only detail snapshots belonging to identities verified in this station.
  for(let i=0;i<rows.length;i+=100){
   const batch=rows.slice(i,i+100);
   const result=await db.from('amazon_da_detail_snapshots').select('provider_id,identity_email,idfy,idfy_at,idfy_error,milestones,milestones_at,milestone_error')
    .eq('company_id',companyId).eq('station_id',stationId).eq('enabled',true).in('provider_id',batch.map(p=>p.providerId));
   if(result.error)throw Error('Saved verification checks are unavailable. Refresh to retry.');
   for(const p of batch){
    const s=result.data?.find(s=>s.provider_id===p.providerId);
    if(!s)continue;
    if(!p.email||!s.identity_email||p.email.trim().toLowerCase()!==s.identity_email.trim().toLowerCase()){
     p.verificationWarning='Verification identity needs review';warnings.push('Some verification records could not be matched to the current Amazon email.');continue;
    }
    if(s.idfy&&(!p.bgc?.checkedAt||Date.parse(s.idfy_at||'')>=Date.parse(p.bgc.checkedAt)))p.bgc=s.idfy as AmazonBgcStatus;
    if(s.idfy_error){p.verificationWarning='Latest IDfy refresh failed · showing last saved check';warnings.push('Some IDfy refreshes failed; last saved checks are shown.');}
    const steps=s.milestones as AmazonDaMilestone[]|null;
    if(Array.isArray(steps)&&steps.length){p.pendingMilestones=pendingMilestones(steps);p.milestonesAt=s.milestones_at;}
    if(s.milestone_error)warnings.push('Some milestone refreshes failed; open the profile to retry.');
   }
  }
  const snapshot=createHash('sha256').update(JSON.stringify(rows.map(p=>[p.providerId,p.status,p.stage,p.health,p.bgc,p.pendingMilestones,p.milestonesAt,p.verificationWarning]))).digest('hex');
  return {rows,checkedAt:times.sort()[0]||new Date().toISOString(),snapshot,warnings:[...new Set(warnings)]};
 })();
 for(const [k,v] of cache)if(Date.now()-v.at>=30_000)cache.delete(k);
 if(cache.size>=64)cache.delete(cache.keys().next().value!);
 cache.set(key,{at:Date.now(),value});value.then(()=>{const saved=cache.get(key);if(saved?.value===value)saved.at=Date.now();},()=>{});value.catch(()=>{if(cache.get(key)?.value===value)cache.delete(key);});
 return value;
}

/** Preserve the all-permitted-stations correction queue. Concurrent roster reads
 * are bounded; failures remain explicit instead of turning into zero pending. */
export async function loadAmazonFilterScope(db:SupabaseClient,companyId:string,stations:Array<{id:string;code:string}>,fresh=false):Promise<Source>{
 if(!stations.length)return {rows:[],checkedAt:new Date().toISOString(),snapshot:'empty',warnings:[]};
 const key=`scope:${companyId}:${stations.map(s=>s.id).sort().join(',')}`;
 const saved=cache.get(key);if(!fresh&&saved&&Date.now()-saved.at<30_000)return saved.value;
 const value=(async()=>{
  const sources:Source[]=[],warnings:string[]=[];let next=0,failed=0;
  const requestPromise=callWorkforceAmazonWorker<{rows:DeskPerson[]}>('/api/admin/amazon/station-desk/idfy-queue',{method:'POST',body:JSON.stringify({companyId,stationIds:stations.map(s=>s.id),fresh}),signal:AbortSignal.timeout(110_000)}).catch(()=>{warnings.push('Correction forms could not be preloaded. Open the profile to retry.');return {rows:[] as DeskPerson[]};});
  await Promise.all(Array.from({length:Math.min(4,stations.length)},async()=>{
   while(next<stations.length){const s=stations[next++];try{const source=await loadAmazonFilterSource(db,companyId,s.id,'bgc',fresh);sources.push({...source,rows:source.rows.map(p=>({...p,stationId:s.id,stationCode:s.code}))});}catch{failed++;warnings.push(`${s.code}: Amazon checks unavailable. Retry refresh.`);}}
  }));
  const rows=sources.flatMap(s=>s.rows);
  // Keep the already-verified inline correction forms from the existing queue.
  try{
   const requests=await requestPromise;
   for(const p of rows){const request=requests.rows?.find(r=>r.providerId===p.providerId&&r.stationId===p.stationId);if(request){p.requestData=request.requestData;if(request.bgc&&(!p.bgc?.checkedAt||Date.parse(request.bgc.checkedAt)>=Date.parse(p.bgc.checkedAt)))p.bgc=request.bgc;}}
  }catch{warnings.push('Correction forms could not be preloaded. Open the profile to retry.');}
  return {rows,checkedAt:sources.map(s=>s.checkedAt).sort()[0]||new Date().toISOString(),snapshot:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),warnings:[...new Set([...warnings,...sources.flatMap(s=>s.warnings)])],incomplete:failed>0};
 })();
 cache.set(key,{at:Date.now(),value});value.then(()=>{const saved=cache.get(key);if(saved?.value===value)saved.at=Date.now();},()=>{});value.catch(()=>{if(cache.get(key)?.value===value)cache.delete(key);});return value;
}
