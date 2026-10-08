import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const load=(file,deps={},extra={})=>{const exports={};new Function('exports','require',...Object.keys(extra),ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,k=>{if(!(k in deps))throw Error(`Unexpected dependency ${k}`);return deps[k];},...Object.values(extra));return exports;};
const policy=load('src/lib/fleet/daily-status-delivery.ts');
for(const time of ['20:00','20:30','21:00','23:59'])assert.equal(policy.fleetDailyStatusDue(time,'20:00:00'),true);
for(const time of ['00:00','19:59','24:00','invalid'])assert.equal(policy.fleetDailyStatusDue(time,'20:00:00'),false);
assert.equal(policy.fleetDailyStatusDue('23:00','25:00'),false);
assert.equal(policy.fleetDailyStatusDue('20:45','20:15'),true);
let running=0,peak=0;
const limited=await policy.deliverFleetStatusBatch([1,2,3,4,5],async x=>{peak=Math.max(peak,++running);await new Promise(r=>setImmediate(r));running--;return x;});
assert.equal(peak,2);assert.equal(limited.deferred,0);assert.equal(limited.results.length,5);
let clock=0,calls=0;
const deferred=await policy.deliverFleetStatusBatch([1,2,3],async()=>{calls++;clock=100;return 'sent';},{concurrency:1,deadline:10,now:()=>clock});
assert.equal(calls,1);assert.equal(deferred.deferred,2);

// Exercise the real cron route with an isolated DB and SMTP stub: no live mail or writes.
const logs=[];let smtpCalls=0,smtpFails=true,logFails=false;
const tables={fleet_control_settings:[{company_id:'fixture',daily_status_email_enabled:true,daily_status_send_time:'20:00:00',daily_status_only_affected:false}],companies:[{id:'fixture',name:'Fixture'}],fleet_vehicles:[{vehicle_no:'FIXTURE',station_code:'TLPB',model:'Fixture van',ownership_type:'own',status:'active'}],fleet_status_report_recipients:[{name:'Fixture',email:'fixture@example.com',station_codes:[]}],fleet_status_report_logs:logs};
for(const name of ['fleet_vehicles','fleet_status_report_recipients'])for(const row of tables[name])Object.assign(row,{company_id:'fixture',is_active:true});
function query(table){let filters=[],op='read',payload,single=false,desc=false,max=Infinity;
 const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,vs){filters.push(r=>vs.includes(r[k]));return q;},order(k,o){desc=o?.ascending===false;return q;},limit(n){max=n;return q;},maybeSingle(){single=true;return q;},upsert(p){op='upsert';payload=p;return q;},update(p){op='update';payload=p;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
  let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));
  if(op==='upsert'){const found=logs.some(r=>['company_id','report_date','recipient_email','region_key'].every(k=>r[k]===payload[k]));rows=found?[]:[{id:`log-${logs.length}`,...payload}];logs.push(...rows);}
  if(op==='update'){if(logFails&&payload.status==='sent')return{data:null,error:{message:'Fixture logging failure'}};rows.forEach(r=>Object.assign(r,payload));}
  if(desc)rows=[...rows].reverse();rows=rows.slice(0,max);return{data:single?rows[0]||null:rows,error:null};
 }).then(resolve,reject);}};return q;}
const recipients=load('src/lib/fleet/daily-status-recipients.ts',{'server-only':{},'@/lib/adhoc-digest-scope':{adHocOpsRoles:new Set()}});
const template=load('src/lib/fleet/daily-status-email.ts');
let iso='2026-10-09T14:29:00Z';
class ClockDate extends Date{constructor(value){super(value===undefined?iso:value);}}
const route=load('src/app/api/cron/fleet-daily-status/route.ts',{
 'node:crypto':{randomUUID:()=>`fixture-${smtpCalls}`},'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status||200})}},
 '@/lib/email':{sendEmail:async args=>{smtpCalls++;assert.equal(args.timeoutMs,8000);assert.deepEqual(args.to,['fixture@example.com']);if(smtpFails)throw Error('421 Temporary System Problem');return{messageId:'fixture-message'};}},
 '@/lib/ops-pulse/adhoc-activity':{loadAdHocActivity:async()=>({stations:[],error:null}),isAdHocActivityLocation:()=>true},
 '@/lib/ops-pulse/cod':{loadCodLocations:async()=>({locations:[{id:'station',station_code:'TLPB',region:'KL'}]})},
 '@/lib/fleet-control-adhoc-scope':{fleetAdHocRequestType:()=>null},
 '@/lib/fleet/daily-status-email':template,
 '@/lib/fleet/daily-status-recipients':{...recipients,loadFleetDailyStatusRecipients:async()=>[]},
 '@/lib/supabase-admin':{supabaseAdmin:{from:query}},'@/lib/fleet/daily-status-delivery':policy
},{Date:ClockDate,process:{env:{CRON_SECRET:'fixture-secret'}},console:{error:()=>{}}});
const run=()=>route.GET(new Request('https://fleet.example/api/cron/fleet-daily-status',{headers:{authorization:'Bearer fixture-secret'}}));
assert.equal((await run()).body.disabled,1);assert.equal(smtpCalls,0);
iso='2026-10-09T14:30:00Z';assert.equal((await run()).status,500);assert.equal(logs[0].status,'failed');
smtpFails=false;iso='2026-10-09T15:00:00Z';assert.equal((await run()).body.sent,1);assert.equal(logs[0].status,'sent');
iso='2026-10-09T15:30:00Z';assert.equal((await run()).body.already_sent,1);assert.equal(smtpCalls,2);
iso='2026-10-10T00:00:00Z';assert.equal((await run()).body.disabled,1);assert.equal(smtpCalls,2);
iso='2026-10-10T14:30:00Z';logFails=true;assert.equal((await run()).status,500);assert.equal(logs.at(-1).status,'skipped');
logFails=false;iso='2026-10-10T15:00:00Z';assert.equal((await run()).body.already_sent,1);assert.equal(smtpCalls,3);
assert.equal((await route.GET(new Request('https://fleet.example/api/cron/fleet-daily-status'))).status,401);
console.log('Fleet mail recovery passed: scheduled daily start, later retry, bounded SMTP, deferred work, no duplicates after sent/accepted, authentication; isolated fixtures only.');
