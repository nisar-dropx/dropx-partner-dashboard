const ts=require('typescript'),fs=require('fs'),assert=require('node:assert/strict');
let auth={companyId:'C',readOnly:false},codes=['KTUR'],failure=false,queries=[];
const cases=[{month:'2026-09',case_key:'515174733475',station_code:'KTUR',company_id:'C',details:{tid:'515174733475'},amount:'30495'},{month:'2026-08',case_key:'slp:515174733475',station_code:'KTUR',company_id:'C',details:{tid:'515174733475'},amount:'100'},{month:'2026-09',case_key:'OTHER',station_code:'PRIVATE',company_id:'C',details:{tid:'515174733475'},amount:'200'},{month:'2026-09',case_key:'FOREIGN',station_code:'KTUR',company_id:'OTHER',details:{tid:'515174733475'},amount:'300'}];
const db={from(table){const filters=[],q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},in:(k,v)=>{filters.push([k,v]);return q;},order:()=>q,then(resolve){queries.push({table,filters});const base=table==='nl_loss_month_cases'?cases:table==='nl_loss_recoveries'?[{month:'2026-09',case_key:'515174733475',company_id:'C',is_deleted:false,outcome_label:'Recover from employees',deduction_month:'2026-10'}]:[{month:'2026-09',case_key:'515174733475',company_id:'C',enabled:true,workflow_status:'awaiting_station'}];resolve({data:base.filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):(k==='details->>tid'?r.details?.tid:r[k])===v)),error:failure?{}:null});}};return q;}};
const m={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/app/api/ops-pulse/losses/search/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
 if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:(a,p,kind)=>!a.denied&&(kind==='access'||!a.editDenied)};
 if(id.endsWith('/nl-loss'))return{nlStationScope:async()=>({company:'C',stations:codes.map(source_code=>({source_code}))}),lossContext:async()=>({settings:{recoverable_statuses:['Recoverable']},outcomes:[]})};
 if(id.endsWith('/supabase-admin'))return{supabaseAdmin:db};
 if(id.endsWith('/loss-recovery-controls'))return{mayActivateRedispute:()=>true,mayMarkAlreadyRecovered:()=>true};
 if(id.endsWith('/supabase-pagination'))return{readAllRows:q=>q};throw Error(id);
},m,m.exports);
const get=shipment=>m.exports.GET(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/search?'+new URLSearchParams({shipment})));
(async()=>{
 let res=await get('515174733475'),j=await res.json();assert.equal(res.status,200);assert.equal(j.rows.length,2,'Exact ID across months, scope excludes other stations and companies');assert.equal(j.rows[0].amount,30495);assert.equal(j.rows[0].recovery.deduction_month,'2026-10');assert.equal(j.rows[0].redispute.enabled,true);assert.equal(j.rows[1].recovery,null);assert.match(res.headers.get('cache-control'),/no-store/);
 assert.ok(queries.filter(q=>q.table==='nl_loss_month_cases').every(q=>q.filters.some(([k,v])=>k==='station_code'&&v[0]==='KTUR')));
 auth.readOnly=true;j=await(await get('515174733475')).json();assert.equal(j.canEdit,false);assert.equal(j.canApprove,false);
 codes=[];queries=[];j=await(await get('515174733475')).json();assert.deepEqual(j.rows,[]);assert.equal(queries.length,0);
 codes=['KTUR'];failure=true;assert.equal((await get('515174733475')).status,500);failure=false;
 assert.equal((await get('x),company_id.eq.OTHER')).status,400);
 auth=null;assert.equal((await get('515174733475')).status,403);
 console.log('PASS loss search: exact cross-month matches, company/station scope, plan and redispute state, read-only, empty scope, invalid ID, database errors');
})().catch(e=>{console.error(e);process.exitCode=1;});
