const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');
const station='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',role='00000000-0000-4000-8000-000000000003';
const fixture={auth:{companyId:'company',userId:'actor',allowed:true,readOnly:false},candidate:null,created:0,queued:0,generated:0,queueFail:false,identity:false,roles:[{id:role,code:'DA',name:'Delivery Associate'},{id:'hk',code:'HK',name:'Housekeeping'}]};
const db={from(table){let write=null,allowedCodes=null;const q={select(){return q},eq(){return q},order(){return q},in(k,v){if(k==='code')allowedCodes=v;return q;},update(v){write=v;return q;},maybeSingle(){return Promise.resolve(result())},then(resolve){return Promise.resolve(result()).then(resolve)}};function result(){if(table==='designations')return {data:fixture.roles.filter(r=>!allowedCodes||allowedCodes.includes(r.code)),error:null};if(table==='workforce_amazon_station_settings')return {data:{invitation_enabled:true,associate_email_pattern:'name@example.resend.app'},error:null};if(write&&fixture.candidate)Object.assign(fixture.candidate,write);return {data:fixture.candidate,error:null};}return q;},async rpc(name,p){if(name==='evaluate_onboarding_identity')return {data:{exact_matches:fixture.identity?[{display_name:'Existing',designation_name:'DA'}]:[],other_matches:[]},error:null};if(name==='workforce_create_isolated_amazon_email_pilot'){fixture.created++;fixture.candidate={...p.p_data,created_by:p.p_actor,alias_email:'example@example.resend.app',closed_at:null,inbox_status:'pending'};return {data:id,error:null};}fixture.queued++;return {data:'queue',error:fixture.queueFail?{message:'Unavailable'}:null};}};
const stubs={
 'next/server':{NextResponse:{json:(data,init)=>Response.json(data,init)}},'@vercel/functions':{waitUntil:()=>{}},
 '@/lib/authorization':{getAuthorization:async()=>fixture.auth,hasPermission:a=>a.allowed,isCompanyOwner:()=>true},
 '@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/ops-workforce-locations':{loadOpsWorkforceLocations:async()=>[{id:station}]},'@/lib/workforce-register-policy':{workforceStationPolicy:()=>({requiresStationEmail:true})},
 '@/lib/designation-onboarding-access':{canOnboardDesignation:()=>true},'@/lib/designation-portal-access':{canAccessDesignationPortal:()=>true},
 '@/lib/dropx-id-generation':{generateConfiguredBiometricId:async()=>{fixture.generated++;return '500001';}},
 '@/lib/workforce-amazon-worker':{workforceAmazonWorkerConfig:()=>({configured:true}),callWorkforceAmazonWorker:async()=>({})},
 '@/lib/amazon-da-desk-policy':{deskUuid:/^[0-9a-f-]{36}$/}
};
function load(path){let normalized=path.startsWith('@/')?path.slice(2):path;if(normalized.startsWith('./'))normalized='lib/'+normalized.slice(2);const alias='@/'+normalized;if(stubs[alias])return stubs[alias];if(stubs[path])return stubs[path];const file=normalized.startsWith('src/')?normalized:'src/'+normalized+'.ts';const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(p=>p.startsWith('@/')||p.startsWith('./')?load(p):stubs[p]||require(p),m,m.exports);return m.exports;}
process.env.AMAZON_EMAIL_ROUTING_PROVIDER='resend';process.env.RESEND_INBOUND_DOMAIN='example.resend.app';
const route=load('src/app/api/ops-pulse/da-onboarding/invite/route.ts');const origin='https://ops.dropxlogistics.com';
const body={id,stationId:station,name:'Example Associate',mobile:'9000000000',designationId:role,reportedOn:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})};
const post=(b=body,o=origin)=>route.POST(new Request(origin+'/api/ops-pulse/da-onboarding/invite',{method:'POST',headers:{Origin:o,'Content-Type':'application/json'},body:JSON.stringify(b)}));
(async()=>{
 assert.equal((await post(body,'https://other.test')).status,403);fixture.auth.readOnly=true;assert.equal((await post()).status,403);fixture.auth.readOnly=false;fixture.auth.isPreview=true;assert.equal((await post()).status,403);fixture.auth.isPreview=false;
 assert.equal((await post({...body,stationId:'unauthorized'})).status,403);assert.equal((await post({...body,designationId:'hk'})).status,403);assert.equal(fixture.created,0);assert.equal(fixture.generated,0);
 fixture.identity=true;assert.equal((await post()).status,409);assert.equal(fixture.created,0);fixture.identity=false;
 let r=await post();assert.equal(r.status,200);assert.equal((await r.json()).email,'example@example.resend.app');assert.equal(fixture.created,1);
 r=await post();assert.equal(r.status,200);assert.equal(fixture.created,1);assert.equal(fixture.generated,1);
 assert.equal((await post({...body,name:'Different person'})).status,409);
 fixture.queueFail=true;r=await post();assert.equal(r.status,202);assert.equal((await r.json()).saved,true);assert.equal(fixture.created,1);
 fixture.queueFail=false;r=await post({id,stationId:station,operation:'retry'});assert.equal(r.status,200);assert.equal(fixture.created,1);
 const p=load('lib/da-onboarding-policy');const row={owner:{onboarding_status:'pending',lifecycle_status:'active',is_active:true},amazon:{status:'ACTIVE'},status:'ACTIVE'};
 assert.equal(p.workforceStage(row),'onboarding');assert.equal(p.workforceNeedsAction(row),true);
 row.owner={onboarding_status:'active',lifecycle_status:'onboarding',is_active:true};assert.equal(p.workforceStage(row),'active');assert.equal(p.workforceNeedsAction(row),false);
 row.owner.lifecycle_status='offboarded';assert.equal(p.workforceStage(row),'offboarded');row.owner.lifecycle_status='inactive';assert.equal(p.workforceStage(row),'inactive');
 assert.deepEqual(p.workforceQueues.map(q=>q.id),['attention','onboarding','active','inactive','offboarded']);
 console.log('Live Workforce: server role allowlist, company/station permissions, CSRF/preview, duplicate review, retry identity, saved-but-not-queued, and independent DropX statuses passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
