const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
const load=(file,stubs)=>{const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>stubs[id]||require(id),m,m.exports);return m.exports;};
(async()=>{
 let owner=true,preview=false,prior=null,inserted=null,sends=0,changed=false,timeout=false;
 const account={id:'account',companyId:'company',profileType:'workforce',name:'Associate'};
 const db={from(){const q={select(){return q},eq(){return q},order(){return q},limit(){return Promise.resolve({data:[]})},maybeSingle(){return Promise.resolve({data:prior})},insert(value){inserted=value;return Promise.resolve({error:null})}};return q;}};
 const api=load('apps/connect/app/api/connect/idfy-corrections/route.ts',{'next/server':{NextResponse:{json:(b,init)=>Response.json(b,init)}},'@/lib/connect-idfy':{ownIdfyContext:async()=>{if(preview)throw Error('Preview blocked');return {account,owner:owner?{provider_id:'verified-provider',identity_email:'own@example.com'}:null,snapshot:{station_id:'station',request_block_ids:['123']},db}},idfyWorker:async(op,body)=>{if(op==='idfy'){assert.equal(body.providerId,'verified-provider');assert.equal(body.expectedEmail,'own@example.com');return {idfy:{profileId:'456'},forms:[{blockId:'123',version:changed?'changed':'a'.repeat(64),unsupported:false}]};}sends++;if(timeout)throw Error('timeout');return {status:'submitted'};}}});
 const body={id:'00000000-0000-4000-8000-000000000001',blockId:'123',version:'a'.repeat(64),values:{address:'Test'},providerId:'forged-provider',actor_id:'other',profileId:'999'};
 const req=(data=body,origin='https://one.example')=>new Request('https://one.example/api/connect/idfy-corrections?accountId=account&profileType=workforce',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await api.POST(req(body,'https://evil.example'))).status,403);assert.equal(sends,0);
 preview=true;assert.equal((await api.POST(req())).status,403);preview=false;
 owner=false;assert.equal((await api.POST(req())).status,409);assert.equal((await (await api.GET(new Request('https://one.example/api'))).json()).linked,false);owner=true;
 changed=true;assert.equal((await api.POST(req())).status,409);changed=false;
 assert.equal((await api.POST(req())).status,200);assert.equal(sends,1);assert.equal(inserted.provider_id,'verified-provider');assert.equal(inserted.actor_id,'account');assert.equal(inserted.idfy_profile_id,'456');
 prior={company_id:'company',provider_id:'verified-provider',actor_id:'account',actor_profile_type:'workforce',status:'submitted'};await api.POST(req());assert.equal(sends,1,'Replay must not resend');
 prior.actor_id='other';assert.equal((await api.POST(req())).status,403);assert.equal(sends,1);prior=null;
 timeout=true;assert.equal((await api.POST(req())).status,202);assert.equal(sends,2);
 console.log('Connect IDfy: account ownership, preview/CSRF rejection, forged identities ignored, stale forms, recorded actor, replay and uncertain submission passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
