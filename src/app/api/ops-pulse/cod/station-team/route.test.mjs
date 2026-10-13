import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function endpoint({auth=null,allowed=true,locations=[],fail=false}={}) {
 const calls=[];
 const dependencies={
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},
  '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>allowed},
  '@/lib/company-scope':{requireCompanyId:()=> 'company'},
  '@/lib/ops-pulse/cod-status-server':{loadCodStatusLocations:async()=>locations},
  '@/lib/ops-pulse/cod-station-team':{loadCodStationTeam:async(...args)=>{calls.push(args);if(fail)throw Error('database details');return{asOf:'2026-10-13',people:[{name:'Lead',phone:'+91 123',shift:'Morning'}]};}},
 };
 const output=ts.transpileModule(fs.readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};
 new Function('require','exports','module',output)(name=>dependencies[name],module.exports,module);
 return {...module.exports,calls};
}
test('anonymous, no permission, and out-of-scope station never read contacts',async()=>{
 for(const options of [{},{auth:{},allowed:false},{auth:{},locations:[{id:'other'}]}]){
  const api=endpoint(options);assert.equal((await api.GET(new Request('https://ops.example/api?location=station'))).status,403);assert.deepEqual(api.calls,[]);
 }
});
test('authorized team is private and no-store, company scope comes from auth',async()=>{
 const api=endpoint({auth:{},locations:[{id:'station'}]});const response=await api.GET(new Request('https://ops.example/api?location=station&company=evil'));
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(api.calls,[['company','station']]);
});
test('People query failure is retryable and does not disclose database details',async()=>{
 const api=endpoint({auth:{},locations:[{id:'station'}],fail:true});const response=await api.GET(new Request('https://ops.example/api?location=station'));
 assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(await response.json()),/database details/);
});
