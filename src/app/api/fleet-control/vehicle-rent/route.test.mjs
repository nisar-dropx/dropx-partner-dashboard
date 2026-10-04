import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(auth,allowed=true)=>{
 let calls=[];
 const query={select(){return this},eq(){return this},in(){return this},order(){return this},limit(){return this},then(resolve){return Promise.resolve(resolve({data:[{id:'vehicle-a'}],error:null}))}};
 const mocks={
 'next/server':{NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{...options,headers:{'Content-Type':'application/json',...options.headers}})}},
 '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>allowed},
 '@/lib/company-scope':{requireCompanyId:()=> 'company-a'},
 '@/lib/ops-pulse/cod':{loadCodLocations:async()=>({locations:[{station_code:'A'}]})},
 '@/lib/supabase-admin':{supabaseAdmin:{from:()=>query,rpc:async(...args)=>{calls.push(args);return {data:'saved',error:null}}}},
 };
 const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>mocks[name],m.exports,m);
 return {...m.exports,calls};
};
const auth={userId:'user-a',locationScopeIds:['station-a'],hasAllLocationAccess:false};
const request=(body)=>new Request('https://fleet.dropxlogistics.com/api/fleet-control/vehicle-rent',{method:'POST',body:JSON.stringify(body)});
const body={vehicleId:'vehicle-a',monthlyRent:15000,effectiveFrom:'2026-09-01',reason:'Opening rate'};
test('rent writes reject signed-out, denied and read-only preview users',async()=>{
 for(const [a,permission,status] of [[null,true,401],[auth,false,403],[{...auth,readOnly:true},true,403]]) {
 const endpoint=compile(a,permission);assert.equal((await endpoint.POST(request(body))).status,status);assert.equal(endpoint.calls.length,0);
 }
});
test('forged vehicle and invalid amounts cannot reach the rent RPC',async()=>{
 for(const [data,status] of [[{...body,vehicleId:'other-company-vehicle'},403],[{...body,monthlyRent:-1},400],[{...body,monthlyRent:1.234},400],[{...body,effectiveFrom:'2026-02-31'},400],[null,400]]) {
 const endpoint=compile(auth);assert.equal((await endpoint.POST(request(data))).status,status);assert.equal(endpoint.calls.length,0);
 }
});
test('valid rent is saved using the authenticated company, actor and exact effective date',async()=>{
 const endpoint=compile(auth);assert.equal((await endpoint.POST(request({...body,companyId:'forged',actor:'forged'}))).status,200);
 assert.deepEqual(endpoint.calls,[['fleet_save_vehicle_rent',{p_company:'company-a',p_vehicle:'vehicle-a',p_amount:15000,p_from:'2026-09-01',p_reason:'Opening rate',p_actor:'user-a'}]]);
});
