import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(path,mocks={})=>{const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m);return m.exports;};
const cps=compile('./cps.ts'), hawkeye=compile('./hawkeye.ts'), policy=compile('./performance-source-policy.ts');
const domain=compile('./command-center.ts',{'./cps':cps,'./hawkeye':hawkeye,'./performance-source-policy':policy});
const {buildCommandCenter,commandCostHref}=domain;
const period={from:'2026-10-01',to:'2026-10-02',days:2};
const day={station_code:'A',work_date:'2026-10-01',deliveries:90,c_return:10,activity:100,associate_rows:2,unmapped:0,unpaid:0,da:800,utr:100,van:100,rent:0,overhead:0,other:0,total:1000,target:12,shipment_present:true,utr_configured:true};
const model=(daily=[day],extra={})=>buildCommandCenter({snapshot:{daily,breakup:[],gaps:[]},places:[{code:'A',name:'Station A'}],period,performance:[],targets:[],reviews:[],performanceDate:period.to,...extra});
test('cost engine parity: sum cost / deliveries plus customer returns, not average ratios',()=>{
 const days=[day,{...day,work_date:period.to,deliveries:890,total:27000,target:30}];
 const m=model(days);assert.deepEqual(m.total,cps.summarizeCps(days));assert.equal(m.total.cps,28);assert.equal(m.total.target,28.2);assert.equal(m.provisional,false);assert.equal(m.observed,2);
});
test('missing target stays null, never a zero target or false overrun',()=>{const m=model([{...day,target:null}]);assert.equal(m.total.target,null);assert.equal(m.aboveTarget,0);assert.equal(m.rows[0].aboveTarget,false);});
test('unconfirmed bill periods keep complete-volume stations provisional',()=>{
 const m=model([],{snapshot:{daily:[day,{...day,work_date:period.to}],breakup:[],expense_periods:[{station_code:'A',source_id:'bill',period_from:period.from,period_to:period.to,confirmed:false}]}});
 assert.equal(m.missingDays,0);assert.equal(m.provisional,true);assert.equal(m.rows[0].gaps,1);
});
test('a reported zero and a missing report remain distinct; cost without volume is not CPS',()=>{
 const m=model([{...day,deliveries:0,c_return:0}]);assert.equal(m.trend[0].deliveries,0);assert.equal(m.trend[1].deliveries,null);assert.equal(m.total.cps,null);assert.equal(m.missingDays,1);assert.equal(m.provisional,true);
 const failed=model([],{snapshot:null});assert.equal(failed.total,null);assert.equal(failed.trend[0].cost,null);
});
test('only selected authorized scope and selected dates contribute, with selected XPT grouping',()=>{
 const x={...day,station_code:'X',deliveries:10,c_return:0,total:300};
 const m=model([day,x,{...day,station_code:'FOREIGN'},{...day,work_date:'2026-09-30'}],{places:[{code:'A',name:'A'},{code:'X',name:'X',isXpt:true,parent:'A'}]});
 assert.equal(m.rows.length,1);assert.deepEqual(m.rows[0].members,['A','X']);assert.equal(m.total.total,1300);assert.equal(m.total.shipments,110);assert.equal(m.expected,4);assert.equal(m.observed,2);
});
test('current configured thresholds and latest same-day Hawkeye row; zero is a valid observation',()=>{
 const fact={id:'1',batch_id:'b',source_type:'amazon_hawkeye_daily',station_code:'A',report_date:period.to,created_at:'2026-10-03T00:00:00Z',values_json:{metrics:{'AFN Std PDD DSR%':0}}};
 const target={metricKey:'dsr',target:.9,direction:'higher',isActive:true};
 const m=model([day],{performance:[{...fact,created_at:'2026-10-02T00:00:00Z',values_json:{metrics:{'AFN Std PDD DSR%':100}}},fact],targets:[target]});
 assert.equal(m.rows[0].missed,1);assert.equal(m.performanceRisk,1);
 assert.equal(model([day],{performance:[fact],targets:[{...target,target:null}]}).performanceRisk,null);
 assert.equal(model().performanceRisk,null);assert.equal(model().performanceMissing,1);
});
test('cost links preserve exact period, group and scope; no broad implicit default',()=>{const q=new URL(commandCostHref(period,['A','X'],'A','unmapped'),'https://example.test').searchParams;assert.equal(q.get('scope'),'A,X');assert.equal(q.get('from'),period.from);assert.equal(q.get('to'),period.to);assert.equal(q.get('station'),'A');});
test('review counts cannot include a location excluded from the cost/model scope',()=>{const m=model([day],{reviews:[{id:'1',station_code:'A'},{id:'2',station_code:'B'}]});assert.equal(m.reviewCount,1);});
test('insight station scope narrows review and cost flags without changing the full snapshot',()=>{
 const a={...day,station_code:'A'},b={...day,station_code:'B',deliveries:10,total:500,target:5};
 const m=buildCommandCenter({snapshot:{daily:[a,b],breakup:[],gaps:[]},places:[{code:'A',name:'A'},{code:'B',name:'B'}],period,performance:[],targets:[],reviews:[{id:'1',station_code:'A'},{id:'2',station_code:'B'}],performanceDate:period.to});
 assert.equal(m.reviewCount,2);assert.equal(m.rows.length,2);
 const scoped=domain.scopeCommandModel(m,['A']);
 assert.equal(scoped.rows.length,1);assert.equal(scoped.reviewCount,1);assert.equal(m.reviewCount,2);
 const items=domain.commandMetricAttention({model:m,period,codes:['A'],canCost:true,canReview:true,canPerformance:false,performanceDate:period.to,today:period.to});
 assert.equal(items.find(i=>i.key==='reviews').count,1);
});
test('insight station scope does not attribute sibling XPT group totals to one station',()=>{
 const a={...day,station_code:'A'},x={...day,station_code:'X',deliveries:10,c_return:0,total:300};
 const m=buildCommandCenter({snapshot:{daily:[a,x],breakup:[],gaps:[]},places:[{code:'A',name:'A'},{code:'X',name:'X',isXpt:true,parent:'A'}],period,performance:[],targets:[],reviews:[{id:'1',station_code:'A'},{id:'2',station_code:'X'}],performanceDate:period.to});
 assert.equal(m.rows.length,1);assert.equal(m.reviewCount,2);
 const scoped=domain.scopeCommandModel(m,['X']);
 assert.equal(scoped.rows.length,0);assert.equal(scoped.reviewCount,0);assert.equal(scoped.provisional,false);
 assert.equal(domain.scopeCommandModel(m,['A','X']).reviewCount,2);
});
test('station search and action filters use real row flags and preserve exact matches',()=>{
 const m=model([day],{places:[{code:'A',name:'North',owner:'Test manager'}]});
 assert.equal(domain.filterCommandRows(m.rows,' MANAGER ','all').length,1);
 assert.equal(domain.filterCommandRows(m.rows,'North','data').length,1);
 assert.equal(domain.filterCommandRows(m.rows,'','cost').length,0);
 assert.equal(domain.filterCommandRows(m.rows,'','reviews').length,0);
 assert.equal(domain.filterCommandRows(m.rows,'unrelated','all').length,0);
});
const {summarizeStoreCpu}=compile('./ds-command-center.ts');
test('Dark Store CPU is weighted, same-cutoff and all-store complete',()=>{
 const a={units:100,cost:500,days:2,through:period.to},b={...a,units:900,cost:900};
 assert.equal(summarizeStoreCpu([a,b]).cpu,1.4);
 assert.equal(summarizeStoreCpu([a,{...b,provisional:true}]).cpu,null);
 for(const rows of [[],[a,{...b,units:null}],[a,{...b,units:0}],[a,{...b,through:period.from}],[a,{...b,days:0}]])assert.equal(summarizeStoreCpu(rows).cpu,null);
});
function loader({permissions=[],failCost=false,failFacts=false}={}){
 const calls=[];const query=table=>new Proxy({table},{get:(o,k)=>k==='then'?resolve=>Promise.resolve(resolve({data:[],error:failFacts&&table==='report_metric_facts'?{}:null})):k in o?o[k]:(...args)=>{calls.push([table,k,...args]);return query(table);}});
 const mod=compile('./command-center-data.ts',{'server-only':{},'@/lib/authorization':{hasPermission:(_a,p)=>permissions.includes(p)},'@/lib/company-scope':{requireCompanyId:()=> 'COMPANY'},'@/lib/supabase-admin':{supabaseAdmin:{from:query}},'@/lib/supabase-pagination':{readAllRows:async q=>await q},'./cps-data':{cpsScope:async()=>({all:[{station_code:'A'},{station_code:'OTHER'}]}),loadCpsSnapshot:async(...args)=>{calls.push(['CPS',...args]);if(failCost)throw Error('test failure');return {daily:[day],breakup:[]};}},'./performance-targets':{loadPerformanceTargets:async(c,options)=>{calls.push(['targets',c,options]);return {rows:[],error:null};},resolvePerformanceTargets:r=>r},'./performance-source-policy':policy,'./command-center':domain,'./loss-recovery-command':{loadLossRecoveryCommand:async(...args)=>{calls.push(['losses',...args]);return {summary:null,hrefs:{}};}}});
 return {calls,run:()=>mod.loadCommandCenter({},[{station_code:'A'}],period,true,'2026-10-03')};
}
test('permission gates avoid restricted sources entirely',async()=>{const t=loader();const r=await t.run();assert.equal(t.calls.length,0);assert.equal(r.canCost,false);assert.equal(r.model.total,null);});
test('loader shares CPS engine, scopes every read and only reads targets',async()=>{
 const t=loader({permissions:['cps_overview','performance','performance_review']});const r=await t.run();assert.deepEqual(r.errors,[]);
 const call=t.calls.find(c=>c[0]==='CPS');assert.deepEqual(call.slice(1,4),['COMPANY',period.from,period.to]);assert.deepEqual(call[4].map(l=>l.station_code),['A']);assert.deepEqual(t.calls.find(c=>c[0]==='targets'),['targets','COMPANY',{readOnly:true}]);
 for(const table of ['report_metric_facts','ops_performance_reviews']){assert(t.calls.some(c=>c[0]===table&&c[1]==='eq'&&c[2]==='company_id'&&c[3]==='COMPANY'));assert(t.calls.some(c=>c[0]===table&&c[1]==='in'&&c[2]==='station_code'&&c[3][0]==='A'));}
});
test('failed cost source is unavailable while independent performance remains usable',async()=>{const t=loader({permissions:['cps_overview','performance'],failCost:true});const r=await t.run();assert.deepEqual(r.errors,['CPS cost source']);assert.equal(r.model.total,null);assert.equal(r.canPerformance,true);});
