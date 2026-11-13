import 'server-only';
import {directReturnEstimate} from './lm-cod-return-fallback';
import {createHash} from 'node:crypto';
import {reportBotDb} from './settings';
import {fetchCortexItinerary,fetchCortexSummaries,readCortexSession,packageCounts} from '../ops-pulse/cortex-client';
import {CodRuntime} from './lm-cod-runtime';
import {codDay,type Journey} from './lm-cod-workflow';

export async function codCacheGet<T>(company:string,location:string,day:string,key:string):Promise<T|null>{
 const r=await reportBotDb().from('report_bot_cod_route_cache').select('payload,expires_at').eq('company_id',company).eq('location_id',location).eq('business_date',day).eq('cache_key',key).maybeSingle();
 if(r.error)throw new Error(r.error.message);return r.data&&Date.parse(r.data.expires_at)>Date.now()?r.data.payload as T:null;
}
export async function codCachePut(company:string,location:string,day:string,key:string,payload:unknown,minutes=1440){
 // A cleared observation is absent, never a SQL NULL in the non-null payload column.
 const table=reportBotDb().from('report_bot_cod_route_cache');
 const r=payload===null
  ?await table.delete().eq('company_id',company).eq('location_id',location).eq('business_date',day).eq('cache_key',key)
  :await table.upsert({company_id:company,location_id:location,business_date:day,cache_key:key,payload,expires_at:new Date(Date.now()+minutes*60000).toISOString()});
 if(r.error)throw new Error(r.error.message);
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validPoint=(p:unknown):p is [number,number]=>Array.isArray(p)&&p.length===2&&p.every(n=>typeof n==='number'&&Number.isFinite(n))&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180;
/** Only explicitly completed/attempted delivery events, never COD transaction time. */
export function lastDeliveryStop(payload:any,driver:string,day:string){
 const d=payload?.itineraryDetails||payload;if(d?.transporterId!==driver)return null;
 const tasks=(d.stops||[]).flatMap((s:any)=>s.tasks||[]).concat((d.inactiveTasks||[]).filter((t:any)=>(t.domainMap?.deviceOperator||t.domainMap?.OPERATOR)===driver));
 const stops=tasks.flatMap((t:any)=>{
  if(!['DELIVERED','DELIVERY_ATTEMPTED'].includes(t.taskState)||!['COMPLETE','ATTEMPTED'].includes(t.executionStatus)||t.transporterId&&t.transporterId!==driver)return [];
  const raw=Number(t.actualExecutionTime),at=raw>1e15?raw/1000:raw<1e12?raw*1000:raw;
  const point=[t.executionGeocode?.latitude,t.executionGeocode?.longitude];
  return Number.isFinite(at)&&at>0&&at<=Date.now()+60000&&codDay(at)===day&&validPoint(point)?[{at,point}]:[];
 }).sort((a:{at:number},b:{at:number})=>b.at-a.at);
 return stops[0]||null;
}
export async function loadCodJourneys(company:string,location:string,day:string,driverIds:string[],runtime:CodRuntime,endpoint:string|null,allowance=15){
 const result=new Map<string,Journey>();if(!driverIds.length)return result;
 const db=reportBotDb();
 const [station,setting,identity]=await Promise.all([
  db.from('stations').select('latitude,longitude,amazon_service_area_id').eq('company_id',company).eq('id',location).single(),
  db.from('workforce_amazon_station_settings').select('amazon_service_area_id').eq('company_id',company).eq('station_id',location).maybeSingle(),
  db.from('workforce_route_scc_snapshots').select('drivers').eq('company_id',company).eq('station_id',location).maybeSingle(),
 ]);
 if(station.error||setting.error||identity.error)return result;
 const area=setting.data?.amazon_service_area_id||station.data?.amazon_service_area_id;
 const point=[Number(station.data?.latitude),Number(station.data?.longitude)];
 if(!area||station.data?.latitude==null||station.data?.longitude==null||!validPoint(point))return result;
 const auth=await runtime.memo('cortex-auth',async()=>{
  const session=await db.from('workforce_sessions').select('cookie').eq('status','active').eq('account_key','default').order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(!session.data?.cookie)return null;
  const cookie=session.data.cookie;const value=await runtime.external(()=>readCortexSession(cookie,AbortSignal.timeout(6000)));return value==='expired'?null:{cookie,session:value};
 });
 if(!auth)return result;
 const summaries=await runtime.memo(`summaries:${location}`,async()=>{
  const cached=await codCacheGet<any>(company,location,day,'summaries');if(cached)return cached;
  const res=await runtime.external(()=>fetchCortexSummaries(auth,day,area,AbortSignal.timeout(6000)));if(res.expired||!res.data)return null;
  // Store only route stubs, not transporter phone numbers or session data.
  const value=res.data.itinerarySummaries||[];await codCachePut(company,location,day,'summaries',value,5);return value;
 });
 if(!summaries)return result;
 const identities=Array.isArray(identity.data?.drivers)?identity.data.drivers:[];
 for(const driverId of driverIds){
  if(Date.now()>runtime.deadline-15000)break;
  try{
   const linked=identities.find((d:any)=>String(d.employeeId)===driverId||d.tasId===driverId);
   const transporter=linked?.tasId||driverId;
   const stubs=summaries.filter((s:any)=>s.transporterId===transporter);
   if(!stubs.length)continue;
   // Require every route to have an explicit remaining count, not a missing field treated as zero.
   const closed=stubs.every((s:any)=>{const p=s.packageSummary||s.ndPackageSummary;return p&&(p.REMAINING!=null||p.remaining!=null)&&packageCounts(p).remaining===0;});
   if(!closed){result.set(driverId,{driverId,lastStopAt:null,distanceKm:null,travelMinutes:null,returnAt:null,dueAt:null,closed:false,basis:'On road'});continue;}
   const key='journey:v2:'+hash([transporter,stubs,point,allowance]);
   const cached=await codCacheGet<Journey>(company,location,day,key);if(cached){result.set(driverId,{...cached,driverId});continue;}
   // Limit enrichment to two route documents per DA; unknown routes are not labelled late.
   if(stubs.length>2)continue;
   const stops=[];
   for(const stub of stubs){const res=await runtime.external(()=>fetchCortexItinerary(auth,stub.itineraryId,area,day,AbortSignal.timeout(6000)));if(res.expired||!res.data)throw new Error('Route unavailable');const stop=lastDeliveryStop(res.data,transporter,day);if(stop)stops.push(stop);}
   const stop=stops.sort((a,b)=>b.at-a.at)[0];if(!stop)continue;
   let estimate:{distanceKm:number;travelMinutes:number;basis?:string}|null=null;
   if(endpoint){
    const routeKey='road:'+hash([stop.point,point]);estimate=await codCacheGet(company,location,day,routeKey);
    if(!estimate){estimate=await runtime.external(async()=>{
     const url=new URL(endpoint);if(url.origin!=='https://dropx-amazon-sync.withered-voice-1c40.workers.dev'||url.pathname!=='/cod-return-estimate')throw new Error('Invalid route service');
     const res=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${process.env.COD_RETURN_API_KEY||''}`,'content-type':'application/json'},body:JSON.stringify({from:stop.point,to:point}),signal:AbortSignal.timeout(6000),cache:'no-store'});
     if(!res.ok)return null;const r=await res.json();return Number.isFinite(r.distanceKm)&&Number.isFinite(r.travelMinutes)&&r.distanceKm>=0&&r.travelMinutes>0?r:null;
    }).catch(()=>null);if(estimate)await codCachePut(company,location,day,routeKey,estimate);}
   }
   estimate??=directReturnEstimate(stop.point,point);
   const returnAt=estimate?stop.at+estimate.travelMinutes*60000:null;
   const journey:Journey={driverId,lastStopAt:stop.at,distanceKm:estimate?.distanceKm??null,travelMinutes:estimate?.travelMinutes??null,returnAt,dueAt:returnAt?returnAt+allowance*60000:null,closed:true,basis:estimate?(estimate.basis||'Road estimate'):'Return estimate unavailable'};
   await codCachePut(company,location,day,key,journey,estimate?1440:10);result.set(driverId,journey);
  }catch{ /* Bounded enrichment failure never becomes an overdue allegation. */ }
 }
 return result;
}
