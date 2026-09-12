import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source=read('src/lib/ops-pulse/review-source-refresh.ts');
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
// Shared backing state survives loading another module / cron invocation.
const jobs=Array.from({length:38},(_,i)=>['stock','outcomes'].map(source=>({station_code:'S'+i,source,due:true,lease_token:null,source_at:null,last_error:null}))).flat();
let active=0, peak=0, mode='fail', finishes=0, claimLoss=0, finishLoss=0;
const db={
  async rpc(name,args){
    if(name==='edd_claim_review_source'){
      const existing=jobs.find(j=>j.lease_token===args.p_token);
      if(existing)return {data:[{...existing}],error:null};
      if(jobs.filter(j=>j.lease_token).length>=2)return {data:[],error:null};
      const job=jobs.find(j=>j.due&&!j.lease_token&&!jobs.some(other=>other.station_code===j.station_code&&other.lease_token));
      if(!job)return {data:[],error:null};
      job.lease_token=args.p_token;
      if(claimLoss-->0)return {data:null,error:{code:'57014'}};
      return {data:[{...job}],error:null};
    }
    const j=jobs.find(j=>j.station_code===args.p_station_code&&j.source===args.p_source);
    if(j.completed_token===args.p_token)return {data:true,error:null};
    assert.equal(j.lease_token,args.p_token);
    j.due=false;j.lease_token=null;j.last_error=args.p_error;j.completed_token=args.p_token;
    if(!args.p_error)j.source_at=args.p_source_at;
    finishes++;
    if(finishLoss-->0)return {data:null,error:{code:'57014'}};
    return {data:true,error:null};
  },
  from(){return {select:async()=>({data:jobs,error:null})};}
};
async function fetchSource({stationCode},feed){
  active++;peak=Math.max(peak,active);
  await new Promise(resolve=>setTimeout(resolve,1));active--;
  if(mode==='fail'&&stationCode==='S0')throw Error('Amazon proxy call failed: 502');
  if(mode==='login_busy')throw Error('Another Amazon login is already in progress');
  return {stationCode,fetchedAt:mode==='stale'?new Date(Date.now()-3600000).toISOString():new Date().toISOString(),
    todayYmd:mode==='wrong_day'?'2000-01-01':day,
    window:{from:feed==='stock'||mode==='wrong_day'?'2000-01-01':day,to:day}};
}
function load(){
  const exports={};
  const deps={'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:db},'./station-edd':{stationEddToday:()=>day},
    './edd-worker':{refreshEddStation:p=>fetchSource(p,'stock'),refreshEddPerformanceStation:p=>fetchSource(p,'outcomes')}};
  new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>deps[key]??require(key),exports);
  return exports;
}
const start=new Date(day+'T06:00:00+05:30');
let runs=await Promise.all([load().refreshReviewSources(start),load().refreshReviewSources(start)]);
assert.equal(finishes,76);assert.ok(peak<=2);assert.equal(jobs.filter(j=>j.last_error).length,2);
assert.equal(Math.max(...runs.map(r=>r.trackedStations)),38);
assert.ok(runs.some(r=>r.waitingStations.includes('S0')));
mode='ok';for(const j of jobs)if(j.last_error)j.due=true;
const recovered=await load().refreshReviewSources(start);
assert.equal(recovered.attempted,2);assert.equal(recovered.freshStations,38);
assert.equal(jobs.filter(j=>j.last_error).length,0);
const valid=jobs[0].source_at;jobs[0].due=true;mode='stale';
await load().refreshReviewSources(start);
assert.equal(jobs[0].source_at,valid,'stale success responses cannot erase a verified source');
assert.equal(jobs[0].last_error,'stale_response');
mode='wrong_day';jobs[0].due=true;jobs[1].due=true;
await load().refreshReviewSources(start);
assert.equal(jobs[0].last_error,'stale_response','stock day must be today even though its backlog window spans months');
assert.equal(jobs[1].last_error,'stale_response','outcome window must be today');
mode='ok';jobs[0].due=true;jobs[1].due=true;claimLoss=1;finishLoss=1;
const beforeRetry=finishes;
const retried=await load().refreshReviewSources(start);
assert.equal(retried.refreshed,2);assert.equal(finishes-beforeRetry,2,'ambiguous commits must not duplicate work or failures');
mode='login_busy';for(const j of jobs)j.due=true;
const loginRun=await load().refreshReviewSources(start);
assert.equal(loginRun.attempted,2,'stop each lane when shared login is busy, leaving other stations queued');
assert.equal(load().reviewRefreshError(Error('Another login is already in progress')),'login_busy');
assert.equal(load().reviewRefreshError(Error('operation timed out')),'timeout');
const before=finishes;await load().refreshReviewSources(new Date(day+'T05:29:00+05:30'));assert.equal(finishes,before);
const migration=read('supabase/migrations/20260912092525_review_edd_durable_source_refresh.sql');
for(const term of ['security invoker','enable row level security','from public, anon, authenticated','for update skip locked','j.lease_token = p_token',"interval '15 minutes'",'least(300','pg_advisory_xact_lock'])assert.ok(migration.includes(term),term);
const cron=JSON.parse(read('vercel.json')).crons;
assert.equal(cron.find(c=>c.path==='/api/cron/edd-stock-refresh').schedule,'* * * * *');
assert.equal(cron.find(c=>c.path==='/api/cron/edd-review-history').schedule,'*/15 * * * *');
console.log('PASS durable EDD sources: 38 locations, overlapping invocations, 2 global lanes, retry recovery, stale responses, retained successes, 15-minute cadence, private lease SQL.');
