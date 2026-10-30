import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const id='11111111-1111-4111-8111-111111111111';
function fixture(options={}){
  const calls=[];const auth={companyId:'company',userId:'reviewer',...options.auth};
  const chain={eq(){return chain},maybeSingle:async()=>({data:options.found===false?null:{id,status:options.status??'submitted'},error:null})};
  const mocks={
    '@/lib/authorization':{getAuthorization:async()=>options.signedOut?null:auth,hasPermission:()=>options.permission!==false},
    '@/lib/access-surface':{currentAdminAccessSurface:()=>options.surface??'dashboard'},
    '@/lib/workforce-connect':{scopedWorkforceCases:()=>chain,workforceConnectOpenStatuses:['submitted'],workforceConnectStatuses:['submitted','closed']},
    '@/lib/firebase-push':{deliverNotificationPush:async()=>calls.push('push')},
    '@/lib/supabase-admin':{supabaseAdmin:{from(table){calls.push(['table',table]);throw Error('Unexpected protected read')},rpc:async(name,args)=>{calls.push([name,args]);return {data:null,error:null}}}}
  };
  const output=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function('require','exports',output)(name=>{assert.ok(mocks[name],name);return mocks[name]},exports);
  return {...exports,calls};
}
function post(body={caseId:id,intent:'reply',value:'A safe test reply'},origin='https://dashboard.example'){
  return new Request('https://dashboard.example/api/workforce-connect',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
}
test('only Dashboard authorized users can read this inbox',async()=>{
  for(const options of [{signedOut:true},{permission:false},{surface:'ops'},{surface:'people'},{surface:'finance'}]){
    const f=fixture(options);assert.equal((await f.GET(new Request(`https://dashboard.example/api/workforce-connect?case=${id}`))).status,403);assert.equal(f.calls.length,0);
  }
});
test('other-portal, other-company and outside-location cases cannot expose messages or sign attachment URLs',async()=>{
  const f=fixture({found:false});
  assert.equal((await f.GET(new Request(`https://dashboard.example/api/workforce-connect?case=${id}`))).status,404);
  assert.equal((await f.POST(post())).status,404);assert.equal(f.calls.length,0);
});
test('read-only previews, missing edit permission and foreign-origin writes are rejected',async()=>{
  for(const options of [{auth:{readOnly:true}},{auth:{isPreview:true}},{permission:false},{surface:'people'}]){
    const f=fixture(options);assert.equal((await f.POST(post())).status,403);assert.equal(f.calls.length,0);
  }
  const f=fixture();assert.equal((await f.POST(post(undefined,'https://other.example'))).status,403);assert.equal(f.calls.length,0);
});
test('reply and all management actions use the scoped atomic RPCs',async()=>{
  for(const intent of ['reply','note','assign','status']){
    const f=fixture();const response=await f.POST(post({caseId:id,intent,value:intent==='status'?'closed':'Test value'}));
    assert.equal(response.status,200);assert.equal(f.calls[0][0],intent==='reply'?'send_workforce_communication_reply':'manage_workforce_communication_case');
    assert.equal(f.calls[0][1].p_company_id,'company');assert.equal(f.calls[0][1].p_actor_id,'reviewer');assert.equal(f.calls[0][1].p_case_id,id);
  }
  const closed=fixture({status:'closed'});assert.equal((await closed.POST(post())).status,409);assert.equal(closed.calls.length,0);
});
