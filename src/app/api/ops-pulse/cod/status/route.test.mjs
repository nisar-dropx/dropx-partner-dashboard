import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function endpoint({auth=null,allowed=true,locations=[],stationCode='GNTF',authError=false}={}) {
 const calls=[];
 const dependencies={
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},
  '@/lib/authorization':{getAuthorization:async()=>{if(authError)throw new Error('Temporary session lookup failure');return auth;},hasPermission:()=>allowed},
  '@/lib/ops-pulse/cod-status-server':{loadCodStatusLocation:async(_auth,id)=>locations.find(l=>l.id===id),codStatusPortalStation:async()=>stationCode},
  '@/lib/ops-pulse/cash-recon-worker':{fetchCodStatus:async(...args)=>{calls.push(args);return{version:1,stationCode};}},
 };
 const output=ts.transpileModule(fs.readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};
 new Function('require','exports','module',output)(name=>dependencies[name],module.exports,module);
 return {...module.exports,calls};
}
test('signed out and no-permission callers never reach the worker',async()=>{
 for(const options of [{},{auth:{},allowed:false}]) {
  const api=endpoint(options);const response=await api.GET(new Request('https://ops.example/api?location=loc'));
  assert.equal(response.status,options.auth?403:401);assert.equal(api.calls.length,0);
 }
});
test('session lookup failure is a retryable JSON response and never a login redirect',async()=>{
 const api=endpoint({authError:true});const response=await api.GET(new Request('https://ops.example/api?location=loc'));
 assert.equal(response.status,503);assert.equal(response.headers.get('location'),null);assert.ok((await response.json()).error);assert.equal(api.calls.length,0);
});
test('a guessed station outside authorized locations is denied before portal access',async()=>{
 const api=endpoint({auth:{},locations:[{id:'allowed'}]});
 assert.equal((await api.GET(new Request('https://ops.example/api?location=another'))).status,403);assert.equal(api.calls.length,0);
});
test('worker receives the server master mapping, never a caller station code',async()=>{
 const api=endpoint({auth:{},locations:[{id:'allowed'}],stationCode:'GNTF'});
 const response=await api.GET(new Request('https://ops.example/api?location=allowed&stationCode=OTHER&refresh=1'));
 assert.equal(response.status,200);assert.deepEqual(api.calls,[['GNTF',true]]);assert.equal(response.headers.get('cache-control'),'private, no-store');
});
