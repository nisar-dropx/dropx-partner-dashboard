const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');
let calls=0;
const fixture={auth:{companyId:'company',amazon:true,guided:true},stations:[{id:'allowed',supported:true},{id:'other-provider',supported:false}]};
const stubs={
 'next/server':{NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),init)}},
 '@/lib/authorization':{getAuthorization:async()=>fixture.auth,hasPermission:(a,key)=>key==='ops_amazon_da'?a.amazon:a.guided},
 '@/lib/supabase-admin':{supabaseAdmin:{}},
 '@/lib/ops-workforce-locations':{loadOpsWorkforceLocations:async()=>fixture.stations},
 '@/lib/workforce-register-policy':{workforceStationPolicy:s=>({requiresStationEmail:s.supported})},
 '@/lib/da-onboarding-data':{loadDARegistry:async(db,company,station,amazon,guided)=>{calls++;return{company,station,amazon,guided,rows:[]};}}
};
const mod={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/app/api/ops-pulse/da-onboarding/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(k=>stubs[k]||require(k),mod,mod.exports);
const get=station=>mod.exports.GET(new Request('https://ops.example/api/ops-pulse/da-onboarding?station='+station));
(async()=>{assert.equal((await get('outside')).status,403);assert.equal(calls,0);assert.equal((await get('other-provider')).status,400);assert.equal(calls,0);let r=await get('allowed');assert.equal(r.status,200);assert.equal((await r.json()).company,'company');fixture.auth.amazon=false;r=await get('allowed');assert.equal((await r.json()).amazon,false);fixture.auth.guided=false;assert.equal((await get('allowed')).status,403);fixture.auth=null;assert.equal((await get('allowed')).status,401);console.log('Unified onboarding: authenticated company/station scope, provider restriction and independent source permissions passed.');})();
