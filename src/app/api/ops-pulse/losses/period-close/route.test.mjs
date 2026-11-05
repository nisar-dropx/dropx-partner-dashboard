import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {mayActivateRedispute} from '../../../../../lib/ops-pulse/loss-recovery-controls.ts';
function harness(role='SLPM',{readOnly=false,permission=true}={}) {
 const writes=[];
 const mocks={
 '@/lib/authorization':{getAuthorization:async()=>({userId:'actor',fullName:'Manager',roleCode:role,isMasterOwner:false,readOnly}),hasPermission:()=>permission},
 '@/lib/ops-pulse/loss-recovery-controls':{mayActivateRedispute},
 '@/lib/ops-pulse/nl-loss':{nlStationScope:async()=>({company:'company',stations:[{source_code:'KLZA'}]})},
 '@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{writes.push({name,args});return {data:1,error:null}}}},
 };
 const m={exports:{}};
 new Function('require','module','exports',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>mocks[n],m,m.exports);
 return {...m.exports,writes};
}
const request=(body={report:'nl',period:'2026-09',stations:['KLZA']},origin='https://ops.dropxlogistics.com')=>new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/period-close',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body)});
test('only four authorized roles can close',async()=>{
 for(const role of ['SLPM','FINMGR','NH','MP']){const h=harness(role);assert.equal((await h.POST(request())).status,200,role);assert.equal(h.writes[0].args.p_actor,'actor');}
 for(const role of ['CM','AOM','GM','TL','SSA']){const h=harness(role);assert.equal((await h.POST(request())).status,403,role);assert.equal(h.writes.length,0);}
});
test('scope, impersonation, permissions and origin fail closed',async()=>{
 for(const opts of [{readOnly:true},{permission:false}]){const h=harness('MP',opts);assert.equal((await h.POST(request())).status,403);assert.equal(h.writes.length,0);}
 const h=harness();assert.equal((await h.POST(request({report:'nl',period:'2026-09',stations:['OTHER']}))).status,403);
 assert.equal((await h.POST(request(undefined,'https://bad.example'))).status,403);assert.equal(h.writes.length,0);
});
test('all periods and empty scopes cannot close; SLP label is retained',async()=>{
 const h=harness();for(const body of [{report:'nl',period:'all',stations:['KLZA']},{report:'nl',period:'2026-09',stations:[]}])assert.equal((await h.POST(request(body))).status,400);
 assert.equal(h.writes.length,0);assert.equal((await h.POST(request({report:'slp',period:'Aug-Sep',stations:['KLZA']}))).status,200);assert.equal(h.writes[0].args.p_period,'Aug-Sep');
});
