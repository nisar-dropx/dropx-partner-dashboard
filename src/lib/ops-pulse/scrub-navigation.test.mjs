import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {activeOpsHref} from './design-navigation.ts';
function load(file,mocks){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>mocks[id],m.exports,m);return m.exports;}
const nav=load('./navigation.ts',{'@/lib/app-navigation':{fleetNavItem:{code:'fleet',label:'Fleet',children:[]}},'@/lib/authorization':{hasPermission:(auth,code)=>auth.pages.includes(code),isCompanyOwner:()=>false},'@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:()=>false}});
test('Scrub belongs only to Operations, live performance to Performance, COD Reports retired',()=>{
 for(const mode of ['amazon_edsp','flipkart_odh_mdh']){
  const items=nav.opsNavCatalogForMode(mode),ops=items.find(i=>i.label==='Operations'),performance=items.find(i=>i.label==='Performance');
  assert.ok(ops.children.some(i=>i.label==='Scrub'&&i.href==='/edd/scrub'));
  assert.ok(performance.children.some(i=>i.label==='Live performance'&&i.href==='/edd/flash'));
  assert.ok(!ops.children.some(i=>i.href==='/edd/flash'));
  assert.ok(!JSON.stringify(items).includes('/cod/reports'));
  assert.equal(activeOpsHref(items,'/edd/scrub','','Scrub'),'/edd/scrub');
  assert.equal(activeOpsHref(items,'/edd/flash','','Live performance'),'/edd/flash');
  assert.equal(activeOpsHref(items,'/edd/AAA/performance','','Live performance'),'/edd/flash');
 }
 assert.equal(nav.firstAllowedOpsHref({pages:['edd_dashboard']}),'/edd/flash');
});
test('old COD report URL redirects to current workspace without reading report data',()=>{
 const page=load('../../app/ops-pulse/cod/reports/page.tsx',{'next/navigation':{redirect:url=>{throw new Error(url)}}});
 assert.throws(()=>page.default(),/\/cod\/status/);
});
test('scrub API retains auth gates and excludes worker rows outside viewer scope',async()=>{
 let denied=null,workerCalls=0;
 const api=load('../../app/api/ops-pulse/edd/scrub/route.ts',{
  'next/server':{NextResponse:{json:(value,init)=>new Response(JSON.stringify(value),init)}},
  '@/lib/ops-pulse/edd-access':{requireEddApi:async()=>denied},
  '@/lib/ops-pulse/load-flash-access':{loadFlashViewerStations:async()=>[{code:'AAA'}]},
  '@/lib/ops-pulse/edd-worker':{fetchScrubNetwork:async(codes,options)=>{workerCalls++;assert.deepEqual(codes,['AAA']);return {stations:[{stationCode:'AAA'},{stationCode:'OUT'}]}}}
 });
 for(const method of ['GET','POST']){const response=await api[method]();assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).stations,[{stationCode:'AAA'}]);}
 denied=new Response('Denied',{status:403});assert.equal((await api.GET()).status,403);assert.equal(workerCalls,2);
});
