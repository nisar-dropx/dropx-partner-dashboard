import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as insight from '../../../../lib/provider-mapping-insights.ts';
const station='11111111-1111-1111-1111-111111111111', provider='22222222-2222-2222-2222-222222222222';
const auth={companyId:'company',hasAllLocationAccess:false,locationScopeIds:[station],roleCode:'OPS'};
function compile({authorization=auth,permission=true,host='ops_provider_mapping',failure=false}={}) {
 const queries=[], calculations=[];
 const db={from(table){const filters=[]; const q={select(){return q},eq(...args){filters.push(args);return q},in(...args){filters.push(args);return q},gte(){return q},lte(){return q},or(){return q},order(){return q},range(){return q},maybeSingle(){q.single=true;return q},then(resolve){queries.push({table,filters});const data={stations:{id:station,station_code:'TEST'},providers:{id:provider,name:'Flipkart',code:'FLIPKART'},cps_shipment_daily:[{work_date:'2026-10-02',total_delivery:10,provider_employee_name:'Example',client:'Flipkart'},{work_date:'2026-10-02',total_delivery:999,client:'Amazon'}],field_executive_provider_mappings:[{id:'mapping',workforce_id:'worker'}],workforce:[{id:'worker'}]}[table];return Promise.resolve({data,error:failure?'unavailable':null}).then(resolve)}};return q}};
 const mocks={
  'next/server':{NextResponse:{json:(body,init)=>new Response(JSON.stringify(body),{...init,headers:{...init.headers,'content-type':'application/json'}})}},
  '@/lib/authorization':{getAuthorization:async()=>authorization,hasPermission:()=>permission},
  '@/lib/provider-mapping-access':{providerMappingPageCodeForCurrentHost:()=>host},
  '@/lib/supabase-admin':{supabaseAdmin:db},
  '@/lib/supabase-pagination':{readAllRows:async q=>q},
  '@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-10-28'},
  '@/lib/provider-mapping-insights':insight,
  '@/lib/workforce-payout-loader':{loadWorkforcePayoutRows:async(...args)=>{calculations.push(args);return {rows:[{id:'mapping',locationId:station,providerMemberId:'200000000001',name:'Example',dropxId:'EX1',paymentMethod:'MG',paymentDetailsAvailable:true,status:'Ready for review',dailyBreakdown:[{date:'2026-10-02',baseAmount:500,attendanceSource:'Roster'}]},{id:'other-mapping',locationId:station,providerMemberId:'200000000002',name:'Other',dailyBreakdown:[]}],error:null}}}
 };
 const m={exports:{}};
 new Function('require','exports','module',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(key=>mocks[key],m.exports,m);
 return {...m.exports,queries,calculations};
}
const req=(extra={})=>new Request('https://ops.dropxlogistics.com/api/provider-mapping/insights?'+new URLSearchParams({stationId:station,providerId:provider,memberId:'200000000001',month:'2026-10',...extra}));
test('authentication, host, permission and station scope checked before reading data',async()=>{
 for(const [options,status] of [[{authorization:null},401],[{permission:false},403],[{host:null},403],[{authorization:{...auth,locationScopeIds:[]}},403]]) {
 const route=compile(options);assert.equal((await route.GET(req())).status,status);assert.equal(route.queries.length,0);assert.equal(route.calculations.length,0);
 }
});
test('invalid requests never query sources',async()=>{
 for(const input of [{stationId:'bad'},{month:'2026-11'},{memberId:'x,company_id.eq.foreign'},{providerId:'bad'}]){const route=compile();assert.equal((await route.GET(req(input))).status,400);assert.equal(route.queries.length,0)}
});
test('read-only calculation binds company, station, saved identity and report date',async()=>{
 const route=compile();const response=await route.GET(req());const data=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
 assert.equal(data.deliveries,10);assert.equal(data.cost,500);assert.equal(data.cps,50);assert.deepEqual(data.people,['Example · EX1']);
 assert.ok(route.queries.every(q=>q.filters.some(([key,value])=>key==='company_id'&&value==='company')));
 const [company,scope,from,to,options]=route.calculations[0];assert.equal(company,'company');assert.equal(scope.hasAllLocationAccess,false);assert.deepEqual(scope.locationScopeIds,[station]);assert.equal(from,'2026-10-01');assert.equal(to,'2026-10-02');assert.deepEqual(options,{workforceIds:['worker'],includeLossRecoveries:false,providerCostSegmentsOnly:true,providerDailyCostBasis:'delivery_days'});
 assert.ok(!JSON.stringify(data).includes('Other'));
});
test('source failure does not return false empty or zero figures',async()=>{
 const route=compile({failure:true});const response=await route.GET(req());assert.equal(response.status,503);assert.equal(route.calculations.length,0);
});
