import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(auth,permission=true,station='A',fieldType='fixed_daily'){
 const writes=[];
 const grants=typeof permission==='boolean'
  ?{cpsAccess:permission,cpsEdit:permission,paymentEdit:permission}
  :{cpsAccess:true,cpsEdit:true,paymentEdit:true,...permission};
 const mocks={
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_auth,code,action)=>code==='cps_inputs'&&action==='access'?grants.cpsAccess:code==='cps_inputs'&&action==='edit'?grants.cpsEdit:code==='payment_settings'&&action==='edit'?grants.paymentEdit:false},
 '@/lib/ops-pulse/cps-data':{cpsScope:async()=>({companyId:'company',all:[{id:'station-a',station_code:'A'}]})},
 '@/lib/ops-pulse/cps':{isoDate:v=>typeof v==='string'&&/^20\d\d-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v},
 '@/lib/supabase-admin':{supabaseAdmin:{rpc(name,args){writes.push({rpc:name,args});return Promise.resolve({data:1,error:null})},from(table){return {select(){return this},eq(){return this},order(){return this},limit(){return this},maybeSingle(){return Promise.resolve({data:table==='designations'?{code:'CLM',name:'Cluster Manager'}:table==='payment_fields'?{code:'VAN_RENT_PER_DAY',label:'Van rental',calculation_type:fieldType,is_custom_production:fieldType==='count_x_rate'}:{id:'bill',station_code:station},error:null})},upsert(value){writes.push({table,value});return Promise.resolve({error:null})},insert(value){writes.push({table,value});return this},update(value){writes.push({table,value});return this},then(resolve){return Promise.resolve(resolve({data:[{id:'saved'}],error:null}))}}}}}
 };
 const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(k=>mocks[k],m.exports,m);return {...m.exports,writes};
}
const auth={userId:'owner',hasAllLocationAccess:true};
const req=body=>new Request('https://ops.dropxlogistics.com/api/ops-pulse/cps/settings',{method:'POST',body:JSON.stringify(body)});
const rule={kind:'people',designation_code:'CLM',mode:'managed',head:'UTR',label:'Manager share',allocation:'equal',effective_from:'2026-09-01'};
test('CPS rules reject signed-out, preview, unauthorized and station-only editors',async()=>{
 for(const [a,allowed] of [[null,true],[{...auth,readOnly:true},true],[auth,false],[{...auth,hasAllLocationAccess:false},true]]){const r=compile(a,allowed);assert.equal((await r.POST(req(rule))).status,403);assert.equal(r.writes.length,0)}
});
test('attendance and CPS mutations enforce their own edit permissions',async()=>{
 const attendance={kind:'attendance',capture_method:'shipment_data',minimum_daily_deliveries:1,review_below_deliveries:15,effective_from:'2026-09-01',change_reason:'Use shipment attendance'};
 const paymentEditor=compile(auth,{cpsEdit:false,paymentEdit:true});
 assert.equal((await paymentEditor.POST(req(attendance))).status,200);
 assert.equal(paymentEditor.writes[0].rpc,'save_workforce_attendance_capture_setting_v2');
 assert.equal((await paymentEditor.POST(req(rule))).status,403);
 const cpsEditor=compile(auth,{cpsEdit:true,paymentEdit:false});
 assert.equal((await cpsEditor.POST(req(attendance))).status,403);
 assert.equal(cpsEditor.writes.length,0);
 assert.equal((await cpsEditor.POST(req(rule))).status,200);
 assert.equal(cpsEditor.writes[0].table,'ops_cps_people_policies');
});
test('GET exposes independent edit capabilities and the UI uses the attendance capability',async()=>{
 const paymentEditor=compile(auth,{cpsAccess:true,cpsEdit:false,paymentEdit:true});
 const paymentData=await (await paymentEditor.GET()).json();
 assert.equal(paymentData.canEdit,false);
 assert.equal(paymentData.canEditAttendance,true);
 const cpsEditor=compile(auth,{cpsAccess:true,cpsEdit:true,paymentEdit:false});
 const cpsData=await (await cpsEditor.GET()).json();
 assert.equal(cpsData.canEdit,true);
 assert.equal(cpsData.canEditAttendance,false);
 const source=readFileSync(new URL('../../../../../components/cps-allocation-settings.tsx',import.meta.url),'utf8');
 const attendanceSection=source.slice(source.indexOf('DA attendance'),source.indexOf('People cost inclusion'));
 assert.match(attendanceSection,/data\.canEditAttendance&&<button/);
 assert.doesNotMatch(attendanceSection,/data\.canEdit&&<button/);
});
test('effective rules use authenticated company and actor; invalid dates fail',async()=>{
 const r=compile(auth);assert.equal((await r.POST(req({...rule,company_id:'forged',updated_by:'forged'}))).status,200);assert.equal(r.writes[0].value.company_id,'company');assert.equal(r.writes[0].value.updated_by,'owner');
 assert.equal((await r.POST(req({...rule,effective_from:'2026-02-31'}))).status,400);
});
test('bill period changes require scope and preserve monetary source records',async()=>{
 const bill={kind:'period',source:'payment',source_id:'11111111-1111-1111-1111-111111111111',period_from:'2026-09-01',period_to:'2026-09-30',reason:'Verified bill',amount:1};
 const denied=compile(auth,true,'B');assert.equal((await denied.POST(req(bill))).status,403);assert.equal(denied.writes.length,0);
 const valid=compile({...auth,hasAllLocationAccess:false});assert.equal((await valid.POST(req(bill))).status,200);assert.equal(valid.writes[0].table,'ops_cps_expense_periods');assert.equal(valid.writes[0].value.amount,undefined);
 assert.equal((await valid.POST(req({...bill,period_to:'2026-08-30'}))).status,400);
});

test('rental source rules are company scoped and cannot suppress package payments',async()=>{
 const body={kind:'component',component_code:'VAN_RENT_PER_DAY',mode:'fleet',effective_from:'2026-09-01',company_id:'forged'};
 for(const a of [null,{...auth,readOnly:true},{...auth,hasAllLocationAccess:false}]){
  const r=compile(a);assert.equal((await r.POST(req(body))).status,403);assert.equal(r.writes.length,0);
 }
 const r=compile(auth);assert.equal((await r.POST(req(body))).status,200);
 assert.equal(r.writes[0].table,'ops_cps_component_policies');assert.equal(r.writes[0].value.company_id,'company');assert.equal(r.writes[0].value.updated_by,'owner');
 const production=compile(auth,true,'A','count_x_rate');assert.equal((await production.POST(req(body))).status,400);assert.equal(production.writes.length,0);
});

 test('attendance policy is company scoped; a review threshold does not become the qualifying threshold',async()=>{
 const body={kind:'attendance',capture_method:'shipment_data',minimum_daily_deliveries:1,review_below_deliveries:15,effective_from:'2026-09-01',change_reason:'Shipment activity qualifies; low delivery days are review only'};
 for(const a of [null,{...auth,readOnly:true},{...auth,hasAllLocationAccess:false}]){const r=compile(a);assert.equal((await r.POST(req(body))).status,403);assert.equal(r.writes.length,0)}
 const r=compile(auth);assert.equal((await r.POST(req(body))).status,200);assert.equal(r.writes[0].rpc,'save_workforce_attendance_capture_setting_v2');assert.equal(r.writes[0].args.p_company_id,'company');assert.equal(r.writes[0].args.p_actor_user_id,'owner');assert.equal(r.writes[0].args.p_minimum_daily_deliveries,1);assert.equal(r.writes[0].args.p_review_below_deliveries,15);
 assert.equal((await r.POST(req({...body,review_below_deliveries:-1}))).status,400);
 });
 test('production payment heads can be configured as P&L-only without changing payroll cards',async()=>{
 const r=compile(auth,true,'A','count_x_rate');assert.equal((await r.POST(req({kind:'component',component_code:'SELLER_PICKUP',mode:'pnl_only',effective_from:'2026-09-01'}))).status,200);assert.equal(r.writes[0].table,'ops_cps_component_policies');assert.equal(r.writes[0].value.mode,'pnl_only');
 });

test('historical fallback requires company edit and valid configurable history',async()=>{
 const body={kind:'fallback',field_code:'KM_RUN',mode:'associate_then_station',lookback_months:3,minimum_history_days:1,effective_from:'2026-09-01'};
 const r=compile(auth,true,'A','count_x_rate');assert.equal((await r.POST(req(body))).status,200);assert.equal(r.writes[0].table,'ops_cps_production_fallback_policies');assert.equal(r.writes[0].value.company_id,'company');
 for(const patch of [{lookback_months:0},{minimum_history_days:0},{mode:'invented'}]) assert.equal((await r.POST(req({...body,...patch}))).status,400);
 const station=compile({...auth,hasAllLocationAccess:false},true,'A','count_x_rate');assert.equal((await station.POST(req(body))).status,403);
});
