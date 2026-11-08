const ts=require('typescript');const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');
// Bundle the actual API with only its infrastructure replaced. No production requests.
const stubs={
 'next/server':'exports.NextResponse={json:(b,i)=>Response.json(b,i)};',
 '@/lib/authorization':'exports.getAuthorization=async()=>fixture.auth; exports.hasPermission=(a,p,m)=>m===\"edit\"?a.edit:a.view;',
 '@/lib/supabase-admin':'exports.supabaseAdmin={from:()=>fixture.query()};',
 '@/lib/ops-workforce-locations':'exports.loadOpsWorkforceLocations=async()=>fixture.stations;',
 '@/lib/workforce-register-policy':'exports.workforceStationPolicy=()=>({requiresStationEmail:true});',
 '@/lib/workforce-amazon-worker':'exports.callWorkforceAmazonWorker=async(path,init)=>{fixture.calls.push({path,body:JSON.parse(init.body)});return path.endsWith(\"profile\")?fixture.profile:{command:{status:\"confirmed\"}};}',
};
(async()=>{
const station='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',provider='amzn1.flex.provider.v1.00000000-0000-4000-8000-000000000003';
const fixture={auth:{companyId:'company',userId:'real-user',fullName:'Real User',roleName:'Station Manager',view:true,edit:true},stations:[{id:station}],calls:[],existing:null,inserted:null,profile:{person:{name:'Verified Amazon Name',status:'ACTIVE'},options:[{action:'OFFBOARD',reasonCode:'REASON'}],canResend:false},query(){let mode='read';const q={select(){return q;},eq(){return q;},order(){return q;},limit(){return q;},maybeSingle:async()=>({data:fixture.existing,error:null}),insert(row){fixture.inserted=row;return Promise.resolve({error:null});},then(resolve){resolve({data:[],error:null});}};return q;}};
function load(path){const source=stubs[path]||ts.transpileModule(fs.readFileSync(path.startsWith('@/')?'src/'+path.slice(2)+'.ts':path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={fixture,module:{exports:{}},exports:{},require:id=>stubs[id]||id.startsWith('@/')?load(id):require(id),Response,Request,URL,console,AbortSignal};context.exports=context.module.exports;vm.runInNewContext(source,context);return context.module.exports;}
const route=load('src/app/api/ops-pulse/amazon-da/route.ts');
const url=`https://ops.dropxlogistics.com/api/ops-pulse/amazon-da?station=${station}`;
const action={stationId:station,id,providerId:provider,action:'OFFBOARD',reasonCode:'REASON',remarks:'Employee left',confirmed:true,expectedStatus:'ACTIVE',actorId:'forged',actorName:'Fake',actorRole:'OWNER'};
const post=(body=action)=>route.POST(new Request(url,{method:'POST',headers:{Origin:'https://ops.dropxlogistics.com','Content-Type':'application/json'},body:JSON.stringify(body)}));
fixture.auth.view=false;assert.equal((await route.GET(new Request(url))).status,403);assert.equal(fixture.calls.length,0);fixture.auth.view=true;
assert.equal((await route.GET(new Request(url.replace(station,'00000000-0000-4000-8000-000000000099')))).status,403);assert.equal(fixture.calls.length,0);
fixture.auth.readOnly=true;assert.equal((await post()).status,403);fixture.auth.readOnly=false;
fixture.auth.isPreview=true;assert.equal((await post()).status,403);fixture.auth.isPreview=false;
assert.equal((await post({...action,action:'TRANSFER'})).status,400);
assert.equal((await post({...action,confirmed:false})).status,400);
assert.equal((await post({...action,expectedStatus:'INACTIVE'})).status,409);
assert.equal((await post({...action,reasonCode:'FORGED'})).status,409);
assert.equal((await post()).status,200);assert.equal(fixture.inserted.actor_id,'real-user');assert.equal(fixture.inserted.actor_name,'Real User');assert.equal(fixture.inserted.associate_name,'Verified Amazon Name');
fixture.existing={...fixture.inserted,status:'confirmed'};fixture.calls=[];assert.equal((await post()).status,200);assert.equal(fixture.calls.length,0);
assert.equal((await post({...action,remarks:'Different request'})).status,409);
fixture.existing.company_id='other';assert.equal((await post()).status,409);
assert.equal((await route.POST(new Request(url,{method:'POST',headers:{Origin:'https://evil.example'},body:JSON.stringify(action)}))).status,403);
console.log('Amazon DA API: scoped reads, edit/preview guards, forbidden transfer, confirmation, stale status, reason validation, trusted actor/name, replay and origin checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
