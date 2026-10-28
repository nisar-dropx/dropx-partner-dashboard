const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
let denied=false, dbError=false, calls=[], contextCalls=[];
const snapshot={outcome_label:'Full recovery',allocations:[{ref:'employee:1',full_name:'Sample User',amount:120,salary_payable:9000,salary_gross:10000,recovery_limit:4500}]};
const events=[{id:'event-1',actor_name:'Station Manager',created_at:'2026-10-27T18:45:30Z',before_value:snapshot,after_value:snapshot}];
const query={};for(const name of ['select','eq','order'])query[name]=(...args)=>{calls.push([name,...args]);return query;};
function load(file){file=path.resolve(file);const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
  if(id.endsWith('/nl-recovery-context'))return{recoveryContext:async(...args)=>{contextCalls.push(args);if(denied)throw Error('outside station scope');return{scope:{company:'company-A'},caseKey:'canonical-TID'};}};
  if(id.endsWith('/supabase-admin'))return{supabaseAdmin:{from:table=>{calls.push(['from',table]);return query;}}};
  if(id.endsWith('/supabase-pagination'))return{readAllRows:async()=>({data:events,error:dbError})};
  if(id.startsWith('@/'))return load('src/'+id.slice(2)+'.ts');return require(id);
},m,m.exports);return m.exports;}
(async()=>{
  const {GET}=load('src/app/api/ops-pulse/losses/recovery/history/route.ts');
  const get=()=>GET(new Request('https://ops.example/api/ops-pulse/losses/recovery/history?month=2026-09&case=old-TID'));
  let res=await get();assert.equal(res.status,200);assert.equal(res.headers.get('Cache-Control'),'private, no-store');
  assert.deepEqual(contextCalls[0],['2026-09','old-TID',false,true],'read-only scoped authorization precedes audit access');
  for(const predicate of [['eq','company_id','company-A'],['eq','month','2026-09'],['eq','case_key','canonical-TID']])assert(calls.some(c=>JSON.stringify(c)===JSON.stringify(predicate)),'audit constrained to '+predicate[1]);
  assert(calls.some(c=>c[0]==='order'&&c[1]==='created_at'&&c[2].ascending===false));
  const data=await res.json();assert.equal(data.history[0].actor_name,'Station Manager');assert.equal(data.history[0].created_at,'2026-10-27T18:45:30Z');
  for(const side of ['before_value','after_value']){const allocation=data.history[0][side].allocations[0];assert.equal(allocation.amount,120);for(const key of ['salary_payable','salary_gross','recovery_limit'])assert.equal(allocation[key],undefined,'private salary redacted from '+side);}
  calls=[];denied=true;res=await get();assert.equal(res.status,403);assert.equal(calls.length,0,'denied scope never reads events');
  denied=false;dbError=true;res=await get();assert.equal(res.status,500);assert.equal((await res.json()).history,undefined,'failure cannot masquerade as empty history');
  console.log('PASS shipment history: scoped read-only access, canonical case, newest-first events, actor/timestamp preservation, both snapshot redactions, denied access and query failure.');
})().catch(e=>{console.error(e);process.exitCode=1;});
