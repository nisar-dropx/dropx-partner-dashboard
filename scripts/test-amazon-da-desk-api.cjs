const ts=require('typescript');const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
// Bundle the actual API with only its infrastructure replaced. No production requests.
const stubs={
 '@/lib/amazon-da-filter-data':'exports.loadAmazonRequestSource=async(companyId,stationIds)=>{fixture.calls.push({requestsOnly:true,companyId,stationIds});return {rows:[],snapshot:"s",warnings:[]};};exports.loadAmazonFilterScope=async(db,companyId,stations)=>{fixture.calls.push({scope:stations,companyId});return {rows:[],snapshot:"s",warnings:[]};};exports.loadAmazonFilterSource=async(db,companyId,stationId,view)=>{fixture.calls.push({filtered:true,companyId,stationId,view});return {rows:[],snapshot:"s",warnings:[]};};',
 '@/lib/amazon-da-filters':'exports.emptyDeskFilters=()=>({});exports.filterDeskPage=(rows,filters)=>({rows,filters});',
 '@/lib/dependent-filters':'exports.facetRows=()=>({rows:[],values:()=>[]});',
 '@/lib/workforce-client-id-queue':'exports.allClientIdRows=async()=>[];exports.loadClientIdMappingsForWorkers=async()=>[];exports.needsClientId=()=>true;exports.providerMappingFor=()=>({});',
 '@/lib/workforce-client-id-partner':'exports.loadClientIdPartnerStates=async()=>new Map();',
 '@/lib/date-format':'exports.dashboardDateInputValue=()=>"2026-11-08";',
 'next/server':'exports.NextResponse={json:(b,i)=>Response.json(b,i)};',
 '@/lib/authorization':'exports.getAuthorization=async()=>fixture.auth; exports.hasPermission=(a,p,m)=>m===\"edit\"?a.edit:a.view;',
 '@/lib/supabase-admin':'exports.supabaseAdmin={from:()=>fixture.query(),rpc:async()=>({data:fixture.reviewer,error:null})};',
 '@/lib/ops-workforce-locations':'exports.loadOpsWorkforceLocations=async()=>fixture.stations;',
 '@/lib/workforce-register-policy':'exports.workforceStationPolicy=()=>({requiresStationEmail:true});',
 '@/lib/workforce-amazon-worker':'exports.callWorkforceAmazonWorker=async(path,init)=>{fixture.calls.push({path,body:JSON.parse(init.body)});return path.endsWith(\"idfy\")?fixture.idfySource:path.endsWith(\"profile\")?fixture.profile:{command:{status:\"confirmed\"}};}',
};
(async()=>{
const station='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',provider='amzn1.flex.provider.v1.00000000-0000-4000-8000-000000000003';
const fixture={auth:{companyId:'company',userId:'real-user',fullName:'Real User',roleName:'Station Manager',view:true,edit:true},stations:[{id:station}],calls:[],existing:null,inserted:null,reviewer:null,profile:{person:{name:'Verified Amazon Name',status:'ACTIVE'},options:[{action:'OFFBOARD',reasonCode:'REASON'}],canResend:false},query(){let mode='read';const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},in(){return q;},range(){return q;},update(row){fixture.updated=row;return q;},maybeSingle:async()=>({data:fixture.updated?{...fixture.existing,...fixture.updated}:fixture.existing,error:null}),insert(row){fixture.inserted=row;return Promise.resolve({error:null});},then(resolve){resolve({data:[],error:null});}};return q;}};
function load(path){const source=stubs[path]||ts.transpileModule(fs.readFileSync(path.startsWith('@/')?'src/'+path.slice(2)+'.ts':path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={fixture,module:{exports:{}},exports:{},require:id=>stubs[id]||id.startsWith('@/')?load(id):require(id),Response,Request,URL,console,AbortSignal,crypto};context.exports=context.module.exports;vm.runInNewContext(source,context);return context.module.exports;}
const route=load('src/app/api/ops-pulse/amazon-da/route.ts');
const url=`https://ops.dropxlogistics.com/api/ops-pulse/amazon-da?station=${station}`;
const action={stationId:station,id,providerId:provider,action:'OFFBOARD',reasonCode:'REASON',remarks:'Employee left',confirmed:true,expectedStatus:'ACTIVE',actorId:'forged',actorName:'Fake',actorRole:'OWNER'};
const post=(body=action)=>route.POST(new Request(url,{method:'POST',headers:{Origin:'https://ops.dropxlogistics.com','Content-Type':'application/json'},body:JSON.stringify(body)}));
fixture.auth.view=false;assert.equal((await route.GET(new Request(url))).status,403);assert.equal(fixture.calls.length,0);fixture.auth.view=true;
assert.equal((await route.GET(new Request(url.replace(station,'00000000-0000-4000-8000-000000000099')))).status,403);assert.equal(fixture.calls.length,0);
fixture.calls=[];
assert.equal((await route.GET(new Request(url+'&view=associates&pageSize=999&offset=-4&query='+('x'.repeat(130))+'&fresh=1'))).status,200);
assert.equal(fixture.calls[0].body.pageSize,24);assert.equal(fixture.calls[0].body.offset,0);assert.equal(fixture.calls[0].body.query.length,100);assert.equal(fixture.calls[0].body.fresh,true);
fixture.calls=[];
assert.equal((await route.GET(new Request(url.replace(station,'00000000-0000-4000-8000-000000000099')+'&view=photo&profile='+provider+'&ticket=example'))).status,403);
assert.equal(fixture.calls.length,0);

fixture.calls=[];
assert.equal((await route.GET(new Request(url.replace(station,'all')+'&view=bgc-pending'))).status,200);
assert.deepEqual(Array.from(fixture.calls[0].body.stationIds),[station]);
fixture.calls=[];
assert.equal((await route.GET(new Request(url.replace(station,'all')+'&view=bgc-pending&stations=00000000-0000-4000-8000-000000000099'))).status,403);
assert.equal(fixture.calls.length,0);
fixture.calls=[];
const fast=await route.GET(new Request(url.replace(station,'all')+'&view=bgc-pending&filters=1'));
assert.equal(fast.status,200);assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0].requestsOnly,true);assert.equal((await fast.json()).counts.all,null,'Do not present the pending-only count as every associate');
fixture.auth.readOnly=true;assert.equal((await post()).status,403);fixture.auth.readOnly=false;
fixture.auth.isPreview=true;assert.equal((await post()).status,403);fixture.auth.isPreview=false;
assert.equal((await post({...action,action:'TRANSFER'})).status,400);
assert.equal((await post({...action,confirmed:false})).status,400);
assert.equal((await post({...action,expectedStatus:'INACTIVE'})).status,409);
assert.equal((await post({...action,reasonCode:'FORGED'})).status,409);
fixture.calls=[];assert.equal((await post()).status,202);assert.equal(fixture.inserted.status,'pending_approval');assert.equal(fixture.calls.some(c=>c.path.endsWith('command')),false,'Pending request must not contact mutation endpoint');assert.equal(fixture.inserted.actor_id,'real-user');assert.equal(fixture.inserted.actor_name,'Real User');assert.equal(fixture.inserted.associate_name,'Verified Amazon Name');
fixture.existing={...fixture.inserted,status:'confirmed'};fixture.calls=[];assert.equal((await post()).status,200);assert.equal(fixture.calls.length,0);
assert.equal((await post({...action,remarks:'Different request'})).status,409);
fixture.existing.company_id='other';assert.equal((await post()).status,409);
assert.equal((await route.POST(new Request(url,{method:'POST',headers:{Origin:'https://evil.example'},body:JSON.stringify(action)}))).status,403);
fixture.existing={...fixture.inserted,status:'pending_approval'};fixture.calls=[];
const review={operation:'review',id,stationId:station,decision:'approved',remarks:'Reviewed request'};
assert.equal((await post(review)).status,403);assert.equal(fixture.calls.length,0);
fixture.reviewer='Finance Manager';fixture.profile.person.status='INACTIVE';assert.equal((await post(review)).status,409);fixture.profile.person.status='ACTIVE';
assert.equal((await post(review)).status,200);assert.equal(fixture.updated.reviewed_by,'real-user');assert.equal(fixture.updated.review_decision,'approved');assert.equal(fixture.calls.filter(c=>c.path.endsWith('command')).length,1);
fixture.updated=null;fixture.existing.status='queued';assert.equal((await post(review)).status,409);
fixture.existing.status='pending_approval';fixture.calls=[];assert.equal((await post({...review,decision:'rejected'})).status,200);assert.equal(fixture.calls.length,0);assert.equal(fixture.updated.status,'rejected');
fixture.updated=null;fixture.existing=null;fixture.inserted=null;fixture.calls=[];
const idfyRequest={operation:'idfy-submit',id,stationId:station,providerId:provider,profileId:'123',blockId:'456',version:'a'.repeat(64),values:{'block[a_add]':'New address'}};
fixture.idfySource={idfy:{profileId:'999'},forms:[{blockId:'456',version:'a'.repeat(64),unsupported:false}]};
assert.equal((await post(idfyRequest)).status,409);assert.equal(fixture.inserted,null,'Forged profile cannot reserve another associate response');
fixture.idfySource.idfy.profileId='123';assert.equal((await post({...idfyRequest,version:'b'.repeat(64)})).status,409);assert.equal(fixture.inserted,null);
assert.equal((await post(idfyRequest)).status,200);assert.equal(fixture.inserted.actor_id,'real-user');assert.equal(fixture.inserted.actor_name,'Real User');assert.equal(fixture.inserted.status,'queued');
fixture.auth.isPreview=true;assert.equal((await post(idfyRequest)).status,403);fixture.auth.isPreview=false;
fixture.calls=[];assert.equal((await route.GET(new Request(url.replace(station,'00000000-0000-4000-8000-000000000099')+'&view=bgc-pending'))).status,403);assert.equal(fixture.calls.length,0);
fixture.calls=[];
assert.equal((await route.GET(new Request(url.replace(station,'00000000-0000-4000-8000-000000000099')+'&view=bgc-address&filters=1'))).status,403);assert.equal(fixture.calls.length,0);
const enhanced=await route.GET(new Request(url+'&view=bgc-address&filters=1&status=ACTIVE&status=ONBOARDING&address=candidate_pending'));
assert.equal(enhanced.status,200);const filtered=await enhanced.json();assert.deepEqual(filtered.filters.status,['ACTIVE','ONBOARDING']);assert.equal(fixture.calls[0].companyId,'company');assert.equal(fixture.calls[0].stationId,station);
fixture.calls=[];assert.equal((await route.GET(new Request(url.replace(station,'all')+'&view=bgc-address&filters=1&location=00000000-0000-4000-8000-000000000099'))).status,403);assert.equal(fixture.calls.length,0);
assert.equal((await route.GET(new Request(url.replace(station,'all')+'&view=bgc-address&filters=1'))).status,200);assert.equal(JSON.stringify(fixture.calls[0].scope.map(s=>s.id)),JSON.stringify([station]));
console.log('IDfy API: station scope, trusted actor, preview denial, forged identity and changed form blocked before reservation.');
console.log('Amazon DA API: scoped reads, edit/preview guards, forbidden transfer, confirmation, stale status, reason validation, trusted actor/name, replay and origin checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
