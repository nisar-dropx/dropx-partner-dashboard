import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const compiled=ts.transpileModule(readFileSync(new URL('./workforce-own-adjustments.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {ownAdjustmentLedger,loadOwnAdjustmentLedger}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const dailyCompiled=ts.transpileModule(readFileSync(new URL('./workforce-daily-card.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {allocateOwnDailyCards}=await import(`data:text/javascript;base64,${Buffer.from(dailyCompiled).toString('base64')}`);
const from='2026-09-01',to='2026-09-30';
const row=(overrides={})=>({id:'claim-1',company_id:'company',workforce_id:'person',adjustment_type:'earning',category:'reimbursement',amount:'200.00',effective_date:'2026-09-12',status:'approved',requested_at:'2026-09-10T09:00:00Z',reviewed_at:'2026-09-11T09:00:00Z',payroll_run_id:null,...overrides});
const account={id:'person',companyId:'company',profileType:'workforce',workspace:'workforce',pageAccess:['earnings']};
const ledger=(rows,mileage=[])=>ownAdjustmentLedger(rows,mileage,'company','person',from,to);
const mileage=(overrides={})=>({adjustment_id:'claim-1',company_id:'company',workforce_id:'person',work_date:'2026-09-09',kilometres:'40',rate_per_km:'5',...overrides});

test('approved and posted count once; pending, rejected and cancelled do not',()=>{
 const result=ledger([row(),row({id:'2',status:'posted',payroll_run_id:'run',adjustment_type:'deduction',amount:'45.50'}),row({id:'3',status:'pending',reviewed_at:null}),row({id:'4',status:'rejected'}),row({id:'5',status:'cancelled',reviewed_at:null})]);
 assert.deepEqual(result.summary,{additions:200,deductions:45.5,net:154.5,pendingCount:1});
 assert.equal(result.entries.find(r=>r.id==='2').status,'posted');
 assert.equal(result.entries.filter(r=>r.includedInEstimate).length,2);
});
test('identical duplicate is not double-counted; conflicting duplicate fails',()=>{
 assert.equal(ledger([row(),row()]).summary.additions,200);
 assert.throws(()=>ledger([row(),row({amount:201})]),/changed during loading/);
});
test('cross-company and cross-person rows fail closed',()=>{
 for(const change of [{company_id:'another-company'},{workforce_id:'another-person'}]){
  assert.throws(()=>ledger([row(change)]),/scope/);
  assert.throws(()=>ledger([row()],[mileage(change)]),/scope/);
 }
});
test('output is a whitelist, never contains internal evidence, identities or comments',()=>{
 const result=ledger([row({reason:'SECRET REASON',review_remarks:'SECRET NOTE',reviewed_by:'SECRET REVIEWER',requested_by:'SECRET MAKER',external_reference:'SECRET REF'})],[mileage({evidence:'SECRET EVIDENCE',created_by:'SECRET AUTHOR'})]);
 assert.equal(JSON.stringify(result).includes('SECRET'),false);
 assert.deepEqual(Object.keys(result.entries[0]).sort(),['amount','category','id','includedInEstimate','kind','mileage','postingDate','requestedAt','reviewedAt','status']);
 assert.deepEqual(result.entries[0].mileage,{workDate:'2026-09-09',kilometres:40,ratePerKm:5});
});
test('work date remains distinct from posting date for late mileage',()=>{
 const result=ledger([row()],[mileage({work_date:'2026-08-31'})]);
 assert.equal(result.entries[0].postingDate,'2026-09-12');
 assert.equal(result.entries[0].mileage.workDate,'2026-08-31');
});
test('unreconciled mileage and duplicate evidence fail closed',()=>{
 for(const change of [{kilometres:41},{rate_per_km:0},{kilometres:NaN},{work_date:'2026-09-13'},{work_date:'2026-02-30'}])assert.throws(()=>ledger([row()],[mileage(change)]),/reconciled/);
 assert.throws(()=>ledger([row()],[mileage(),mileage()]),/Duplicate mileage/);
});
test('invalid amounts, history, states and unsupported dates cannot produce an estimate',()=>{
 for(const amount of [0,-1,'NaN',Infinity,'1.001',Number.MAX_SAFE_INTEGER])assert.throws(()=>ledger([row({amount})]),/amount/);
 for(const change of [{status:'paid'},{status:'draft'},{adjustment_type:'payroll'},{status:'posted'},{reviewed_at:null},{requested_at:'bad date'},{reviewed_at:'bad date'},{effective_date:'2026-08-31'},{effective_date:'2026-02-30'}])assert.throws(()=>ledger([row(change)]));
 for(const range of [['2026-02-30',to],[to,from],['2025-01-01',to]])assert.throws(()=>ownAdjustmentLedger([],[],'company','person',...range));
});

function database(respond){
 const calls=[];
 return {calls,from(table){const query={table,operations:[]};calls.push(query);
  const chain={};for(const method of ['select','eq','is','neq','in','gte','lte','or','order','range'])chain[method]=(...args)=>{query.operations.push([method,...args]);return chain;};
  chain.maybeSingle=()=>{query.operations.push(['maybeSingle']);return Promise.resolve(respond(query));};
  chain.then=(resolve,reject)=>Promise.resolve(respond(query)).then(resolve,reject);return chain;
 }};
}
const operation=(query,method,...args)=>query.operations.some(op=>JSON.stringify(op)===JSON.stringify([method,...args]));
test('loader checks page/workspace authorization before accessing any table',async()=>{
 const db=database(()=>{throw Error('must not query');});
 for(const change of [{workspace:'people'},{pageAccess:[]}])await assert.rejects(loadOwnAdjustmentLedger(db,{...account,...change},from,to),/access/);
 assert.equal(db.calls.length,0);
});
test('canonical and protected legacy lookups use exact company and identity',async()=>{
 for(const profileType of ['workforce','contractor','employee','field_executive']){
  const db=database(q=>({data:q.table==='workforce'?{id:'person'}:q.table==='workforce_adjustments'?[row()]:[mileage()],error:null}));
  const result=await loadOwnAdjustmentLedger(db,{...account,profileType},from,to);
  assert.equal(result.summary.additions,200);
  for(const query of db.calls)assert.ok(operation(query,'eq','company_id','company'));
  const identity=db.calls[0];
  assert.ok(operation(identity,'is','deleted_at',null));assert.ok(operation(identity,'neq','migration_state','reclassified'));
  if(profileType==='workforce')assert.ok(operation(identity,'eq','id','person'));
  else {assert.ok(operation(identity,'eq','source_profile_type',profileType));assert.ok(operation(identity,'eq','source_profile_id','person'));}
  for(const query of db.calls.slice(1))assert.ok(operation(query,'eq','workforce_id','person'));
  const adjustment=db.calls[1];assert.ok(operation(adjustment,'gte','effective_date',from));assert.ok(operation(adjustment,'lte','effective_date',to));
  assert.ok(adjustment.operations.find(op=>op[0]==='in'&&op[1]==='status'&&!op[2].includes('draft')));
  for(const query of db.calls){const columns=query.operations.find(op=>op[0]==='select')[1];assert.doesNotMatch(columns,/\*|reason|remarks|evidence|requested_by|reviewed_by|external_reference/);}
 }
});
test('missing canonical link is explicitly unavailable, not a healthy empty ledger',async()=>{
 const db=database(()=>({data:null,error:null}));
 assert.equal((await loadOwnAdjustmentLedger(db,account,from,to)).available,false);
 assert.equal(db.calls.length,1);
});
test('data and ambiguous-identity failures cannot silently become zero',async()=>{
 for(const failTable of ['workforce','workforce_adjustments','workforce_mileage_claims']){
  const db=database(q=>q.table===failTable?{data:null,error:{message:'sensitive db info'}}:{data:q.table==='workforce'?{id:'person'}:q.table==='workforce_adjustments'?[row()]:[],error:null});
  await assert.rejects(loadOwnAdjustmentLedger(db,account,from,to),error=>!error.message.includes('sensitive db info'));
 }
});
test('more than one database page is reconciled, mileage lookups are chunked',async()=>{
 const db=database(q=>{
  if(q.table==='workforce')return {data:{id:'person'},error:null};
  if(q.table==='workforce_mileage_claims')return {data:[],error:null};
  const offset=q.operations.find(op=>op[0]==='range')[1];
  return {data:Array.from({length:offset===0?500:1},(_,n)=>row({id:`${offset+n}`,amount:1})),error:null};
 });
 const result=await loadOwnAdjustmentLedger(db,account,from,to);
 assert.equal(result.entries.length,501);assert.equal(result.summary.additions,501);
 assert.equal(db.calls.filter(q=>q.table==='workforce_mileage_claims').length,6);
 assert.ok(db.calls.some(q=>operation(q,'range',500,999)));
});
test('unbounded or unexpectedly scoped results are rejected',async()=>{
 const db=database(q=>({data:q.table==='workforce'?{id:'person'}:Array.from({length:500},(_,n)=>row({id:`${n}`})),error:null}));
 await assert.rejects(loadOwnAdjustmentLedger(db,account,from,to),/Too many/);
 const other=database(q=>({data:q.table==='workforce'?{id:'person'}:q.table==='workforce_adjustments'?[row({workforce_id:'other'})]:[],error:null}));
 await assert.rejects(loadOwnAdjustmentLedger(other,account,from,to),/scope/);
});

function earningsRoute(db,authenticate=async()=>account,resolveMapping=()=>null){
 const source=readFileSync(new URL('../../app/api/connect/earnings/route.ts',import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 const imports={
  '@/lib/workforce-payment-mapping':{paymentMappingForDay:resolveMapping},
  '@/lib/workforce-payment-period':{workforcePaymentMonth:()=>({from})},
  'next/server':{NextResponse:{json:(body,init)=>new Response(JSON.stringify(body),{...init,headers:{'Content-Type':'application/json',...init?.headers}})}},
  '../../../../src/lib/connect-auth':{requireConnectAccount:authenticate},
  '../../../../src/lib/supabase-admin':{supabaseAdmin:db},
  '@/lib/workforce-own-adjustments':{loadOwnAdjustmentLedger},
  '@/lib/workforce-daily-card':{allocateOwnDailyCards}
 };
 new Function('require','exports',output)(name=>{assert.ok(imports[name],`unexpected import ${name}`);return imports[name];},module.exports);
 return module.exports.GET;
}
const request=()=>new Request('https://one.example/api/connect/earnings?accountId=person&profileType=workforce&month=2026-09');
test('route denies expired/foreign accounts before reading any earnings data',async()=>{
 const db=database(()=>{throw Error('must not query');});
 const response=await earningsRoute(db,async()=>{throw Error('This account is not available for the current login.');})(request());
 assert.equal(response.status,400);assert.equal(db.calls.length,0);
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('vary'),'Cookie');
 assert.equal('summary' in await response.json(),false);
});
test('route reconciles adjustments without provider mappings and preserves statement separation',async()=>{
 const db=database(q=>({data:q.table==='workforce'?{id:'person'}:q.table==='workforce_adjustments'?[row(),row({id:'deduction',adjustment_type:'deduction',amount:25,status:'posted',payroll_run_id:'run'}),row({id:'pending',status:'pending',reviewed_at:null,amount:500})]:[],error:null}));
 const response=await earningsRoute(db)(request()),body=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 assert.equal(response.headers.get('vary'),'Cookie');assert.equal(body.earnings.length,0);
 assert.deepEqual(body.summary,{workDays:0,baseAmount:0,additions:200,grossAmount:200,deductionAmount:25,netAmount:175});
 assert.equal(body.adjustments.summary.pendingCount,1);
 assert.equal(db.calls.some(q=>['workforce_payroll_items','payment_requests'].includes(q.table)),false);
});
test('route fails closed on adjustment lookup error, never returns partial financial totals',async()=>{
 const db=database(q=>({data:q.table==='workforce'?{id:'person'}:[],error:q.table==='workforce_adjustments'?{message:'db failed'}:null}));
 const response=await earningsRoute(db)(request()),body=await response.json();
 assert.equal(response.status,400);assert.match(body.error,/could not be loaded/);assert.equal('summary' in body,false);
 assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('route shares fixed daily pay across provider IDs but retains each ID trace',async()=>{
 const card={id:'card',provider_id:'provider',station_id:'station',designation_id:null,pay_type:'fixed_daily',effective_from:from,effective_to:to,status:'active',fixed_amount:800,guarantee_amount:0,delivery_rate:0,return_rate:0,mfn_rate:0,mfn_return_rate:0,fuel_rate:0};
 const mappings=['A','B'].map(id=>({id,provider_member_id:id,provider_id:'provider',station_id:'station',providers:{name:'Provider'},payment_methods:{name:'Fixed daily'}}));
 const source=mappings.map((m,n)=>({id:'source-'+n,provider_employee_id:m.id,work_date:from,station_code:'TEST',client:'Provider',total_delivery:n?50:10,total_activity:n?50:10,c_return:0,mfn:0,mfn_return:0}));
 const db=database(q=>({data:q.table==='workforce'?{id:'person'}:q.table==='field_executive_provider_mappings'?mappings:q.table==='cps_shipment_daily'?source:q.table==='stations'?[{id:'station',station_code:'TEST'}]:q.table==='workforce_rate_cards'?[card]:[],error:null}));
 const response=await earningsRoute(db,async()=>account,(all,row)=>all.find(m=>m.provider_member_id===row.provider_employee_id))(request()),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.earnings.length,2);assert.equal(body.summary.workDays,1);assert.equal(body.summary.baseAmount,800);assert.equal(body.summary.netAmount,800);
 assert.deepEqual(body.earnings.map(e=>e.baseAmount),[133.33,666.67]);
 assert.ok(db.calls.filter(q=>q.table==='cps_shipment_daily').every(q=>operation(q,'eq','company_id','company')));
});

test('client guard contract: keyed accounts, latest response only, no silent imported-pay fallback',()=>{
 const payments=readFileSync(new URL('../components/connect-workforce-payments.tsx',import.meta.url),'utf8');
 const monthly=readFileSync(new URL('../components/connect-my-earnings.tsx',import.meta.url),'utf8');
 for(const source of [payments,monthly]){
  assert.match(source,/key=\{`\$\{/);assert.match(source,/version!==generation.current/);assert.match(source,/generation.current\+\+/);assert.match(source,/setData\(null\)/);
 }
 assert.match(payments,/if\(!response.ok\)throw new Error\(payload.error\|\|'Unable to reconcile your payment estimate/);
 assert.match(payments,/if\(!earningsAllowed\)return null;/);
 assert.match(payments,/data && calculated && !loading && !visibleError/);
 assert.match(monthly,/data\?\.month===month/);
 assert.match(payments,/ConnectPayAdjustments ledger=\{calculated.adjustments\}/);
});

function renderLedger(value){
 const source=readFileSync(new URL('../components/connect-pay-adjustments.tsx',import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const module={exports:{}},require=createRequire(import.meta.url);
 new Function('require','exports',output)(name=>name.endsWith('.module.css')?new Proxy({},{get:(_target,key)=>String(key)}):require(name),module.exports);
 return renderToStaticMarkup(createElement(module.exports.ConnectPayAdjustments,{ledger:value}));
}
test('associate component renders original/posting dates and distinguishes payroll from paid',()=>{
 const html=renderLedger(ledger([row({status:'posted',payroll_run_id:'run'})],[mileage({work_date:'2026-08-31'})]));
 for(const text of ['Travel reimbursement','31 Aug 2026','12 Sept 2026','40 km','In payroll','Check your statement for payment progress','not your unpaid balance'])assert.ok(html.includes(text),text);
 assert.equal(html.includes('SECRET'),false);
});
test('component distinguishes unlinked identity, genuine empty result and pending claim',()=>{
 assert.match(renderLedger({available:false,entries:[],summary:{}}),/Workforce must link this profile/);
 assert.match(renderLedger(ledger([])),/No payment adjustments posted for this month/);
 const pending=renderLedger(ledger([row({status:'pending',reviewed_at:null})]));
 assert.match(pending,/Awaiting review/);assert.match(pending,/Not included in the payment estimate/);
});
test('component limits initial rows to one page with accessible controls',()=>{
 const html=renderLedger(ledger(Array.from({length:26},(_,id)=>row({id:String(id)}))));
 assert.equal((html.match(/<li>/g)||[]).length,25);assert.match(html,/Adjustment pages/);assert.match(html,/1 \/ 2/);
});
