import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { pushSignature,validPushSignature } from './connect-push-auth.ts';

function api(db,send) {
  const source=readFileSync(new URL('../../app/api/internal/connect-push/route.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mocks={'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/firebase-push':{deliverNotificationPush:send},'@/lib/connect-push-auth':{validPushSignature}};
  const exports={};new Function('require','exports',compiled)(name=>{assert(name in mocks);return mocks[name]},exports);return exports;
}
test('relay rejects unauthenticated callers before any database access',async()=>{
  const route=api({rpc(){throw Error('should not access DB')}},()=>assert.fail());
  const response=await route.POST(new Request('https://one.example/api/internal/connect-push',{method:'POST',body:'{}'}));
  assert.equal(response.status,401);
});
test('authenticated relay sends only the stored recipient/content and skips already claimed IDs',async()=>{
  const previous=process.env.CONNECT_PUSH_RELAY_SECRET;process.env.CONNECT_PUSH_RELAY_SECRET='test'.repeat(16);
  try {
    const id='11111111-1111-4111-8111-111111111111';let claimed=false;const delivered=[];
    const row={id,company_id:'co',recipient_profile_type:'employee',recipient_account_id:'owner',title:'Stored title',body:'Stored body',route:'communication_center',data:{caseId:'case'}};
    const db={async rpc(name,args){assert.equal(name,'claim_connect_push');assert.equal(args.p_notification_id,id);if(claimed)return {data:[],error:null};claimed=true;return {data:[row],error:null}},from(){const q={select(){return q},eq(){return q},async single(){return {data:{push_status:'sent'}}}};return q;}};
    const route=api(db,async message=>delivered.push(message));
    const request=()=>{const body=JSON.stringify({notificationId:id,accountId:'attacker',body:'Injected'}),time=String(Date.now());return new Request('https://one.example/api/internal/connect-push',{method:'POST',headers:{'x-dropx-time':time,'x-dropx-signature':pushSignature(process.env.CONNECT_PUSH_RELAY_SECRET,time,body)},body})};
    assert.equal((await route.POST(request())).status,200);assert.equal((await route.POST(request())).status,200);
    assert.equal(delivered.length,1);assert.equal(delivered[0].accountId,'owner');assert.equal(delivered[0].body,'Stored body');
  } finally {if(previous===undefined)delete process.env.CONNECT_PUSH_RELAY_SECRET;else process.env.CONNECT_PUSH_RELAY_SECRET=previous;}
});
