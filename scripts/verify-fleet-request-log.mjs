import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
function load(file,mocks){const mod={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{if(!(name in mocks))throw Error(name);return mocks[name]},mod,mod.exports);return mod.exports;}
const fetchModule=load('src/lib/fleet/audit-fetch.ts',{});
const audit={...fetchModule,...load('src/lib/fleet/audit-context.ts',{'node:async_hooks':{AsyncLocalStorage},'./audit-fetch':fetchModule})};
let auth={companyId:'company',userId:'person',fullName:'Person'},logs=[],calls=0;
const {withFleetSystemLog}=load('src/lib/fleet/system-log.ts',{'server-only':{},'next/server':{NextResponse:{json:Response.json}},'node:crypto':{randomUUID},'@/lib/authorization':{getAuthorization:async()=>auth},'@/lib/supabase-admin':{supabaseAdmin:{from:()=>({insert:async row=>{logs.push(row);return {error:null}}})}},'./audit-context':audit});
const handler=withFleetSystemLog(async()=>{calls++;assert.equal(audit.fleetAuditContext.getStore().actorId,'person');return Response.json({ok:true})});
const request=()=>new Request('https://fleet.test/api/fleet/vehicles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'vehicle.update',actorId:'forged',bank_account_no:'private'})});
assert.equal((await handler(request())).status,200);assert.equal(logs[0].actor_user_id,'person');assert.ok(!JSON.stringify(logs).includes('private'));assert.equal(audit.fleetAuditContext.getStore(),undefined);
auth={...auth,readOnly:true,isMasterOwner:true,viewerUserId:'viewer'};
assert.equal((await handler(request())).status,403);assert.equal(calls,1,'Even an owner target cannot bypass read-only preview');assert.equal(logs.at(-1).outcome,'denied');assert.equal(logs.at(-1).actor_user_id,'viewer');
auth={...auth,readOnly:false};const denied=withFleetSystemLog(async()=>Response.json({error:'denied'},{status:403}));assert.equal((await denied(request())).status,403);assert.equal(logs.at(-1).outcome,'denied');
await assert.rejects(withFleetSystemLog(async()=>{throw Error('failure')})(request()),/failure/);assert.equal(logs.at(-1).outcome,'failed');
let header;await audit.fleetAuditContext.run({actorId:'person',actorLabel:'മലയാളം',requestId:'id',viewerId:null,route:'/fleet',companyId:'company',action:'update'},()=>audit.fleetAuditFetch(async(_,init)=>{header=new Headers(init.headers).get('x-fleet-audit');return new Response()} )('https://test'));assert.equal(JSON.parse(header).actorId,'person');assert.ok(!header.includes('actorLabel'));
console.log('Fleet request logging: verified actor, denied/failed outcomes, preview write block and context isolation passed.');
