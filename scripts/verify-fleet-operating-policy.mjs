import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(file,deps={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>deps[id]??{},m.exports,m);return m.exports;}
const policy=compile('src/lib/fleet/operating-policy.ts');
assert.equal(policy.operatingPolicyFromSettings({audit_programme:{enabled:false}}).availabilityTargetPercent,90);
assert.deepEqual(policy.validateFleetOperatingPolicy({availabilityTargetPercent:97.5,serviceWorkTypes:[' EV check ','EV check','Brake check']}),{availabilityTargetPercent:97.5,serviceWorkTypes:['EV check','Brake check']});
for(const target of [-1,0,101,'bad',null])assert.throws(()=>policy.validateFleetOperatingPolicy({availabilityTargetPercent:target,serviceWorkTypes:['Service']}));
assert.throws(()=>policy.validateFleetOperatingPolicy({availabilityTargetPercent:90,serviceWorkTypes:[]}));
for(const days of ['',null,-1,0,1.5,366,'bad'])assert.throws(()=>policy.policyDays(days,'Warning'));
assert.equal(policy.policyDays('21','Warning'),21);
const plans=[{vehicleId:'a',status:'scheduled',serviceDate:'2026-10-20'},{vehicleId:'a',status:'completed',serviceDate:'2026-10-01'},{vehicleId:'a',status:'scheduled',serviceDate:'2026-10-10'},{vehicleId:'b',status:'scheduled',serviceDate:'2026-10-11'}];
for(const order of [plans,[...plans].reverse()])assert.equal(policy.nextServicePlans(order).get('a').serviceDate,'2026-10-10');
for(const dates of [['','2026-10-07'],['2026-02-31','2026-10-07'],['2026-10-08','2026-10-07'],['2020-01-01','2026-10-07']])assert.ok(policy.reportDateRangeError(...dates));
assert.equal(policy.reportDateRangeError('2026-10-07','2026-10-07'),null);
function endpoint({allowed=true,conflict=false}={}){
 const writes=[],filters=[];
 const query={select(){return this},eq(...args){filters.push(args);return this},is(...args){filters.push(args);return this},update(value){writes.push(value);return this},maybeSingle(){return Promise.resolve({data:writes.length?(conflict?null:{company_id:'company-a'}):{risk_weights:{audit_programme:{enabled:false},existing:42},updated_at:'previous-version'},error:null})}};
 const mocks={
 '@/lib/fleet/operating-policy':policy,
 '@/lib/fleet/system-log':{withFleetSystemLog:fn=>fn},
 '@/lib/authorization':{getAuthorization:async()=>({userId:'manager',companyId:'company-a',isMasterOwner:false,hasAllLocationAccess:true}),hasPermission:(_a,code)=>['fleet_settings','fleet_masters'].includes(code)?allowed:true},
 '@/lib/company-scope':{requireCompanyId:()=> 'company-a'},
 '@/lib/access-surface':{fleetAccessPageCodes:['fleet_tracking']},
 '@/lib/fleet-control':{hasActiveFleetMembership:async()=>true},
 '@/lib/supabase-admin':{supabaseAdmin:{from:()=>query}},
 'next/server':{NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),options)}}
 };
 return {...compile('src/app/api/fleet-control/route.ts',mocks),writes,filters};
}
const body={action:'settings.update-operating-policy',companyId:'forged-company',operatingPolicy:{availabilityTargetPercent:95,serviceWorkTypes:['EV inspection']}};
const request=(value)=>new Request('https://fleet.dropxlogistics.com/api/fleet-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
let api=endpoint({allowed:false});assert.equal((await api.POST(request(body))).status,403);assert.equal(api.writes.length,0);
api=endpoint();assert.equal((await api.POST(request({...body,operatingPolicy:{...body.operatingPolicy,availabilityTargetPercent:101}}))).status,400);assert.equal(api.writes.length,0);
api=endpoint();assert.equal((await api.POST(request(body))).status,200);assert.deepEqual(api.writes[0].risk_weights,{audit_programme:{enabled:false},existing:42,operating_policy:body.operatingPolicy});assert.ok(api.filters.some(([k,v])=>k==='company_id'&&v==='company-a'));assert.ok(api.filters.some(([k,v])=>k==='updated_at'&&v==='previous-version'));assert.equal(api.writes[0].updated_by,'manager');
api=endpoint({conflict:true});assert.equal((await api.POST(request(body))).status,409);
console.log('Fleet policy, earliest service, report dates, authorization, company scope and concurrent settings checks passed.');
