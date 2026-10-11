import {test} from 'node:test';
import assert from 'node:assert/strict';
import {betaLearning,betaTaskComplete,betaInboxActions,verifiedBetaSnapshot,verificationState} from './beta-verification.ts';
import fs from 'node:fs';
import ts from 'typescript';
import * as verification from './beta-verification.ts';
import * as actionUrls from './onboarding-action-url.ts';
import {betaJourney} from './beta-journey.ts';
import {betaIdfyMessageExamples} from './beta-idfy-message-examples.ts';
test('verification failures and negations never become green',()=>{for(const s of ['not verified','verified_red','insufficient','not completed'])assert.notEqual(verificationState(s),'complete');assert.equal(verificationState('Green'),'complete');});
test('a different provider or email cannot supply a candidate status',()=>{const s={amazon_profile_id:'p1',identity_email:'one@example.test'};assert.equal(verifiedBetaSnapshot(s,'two@example.test','p1'),null);assert.equal(verifiedBetaSnapshot(s,'one@example.test','p2'),null);assert.equal(verifiedBetaSnapshot(s,'ONE@example.test','p1'),s)});
test('LM deadline uses actual creation evidence and waits for BGC submission',()=>{const now=Date.parse('2026-10-20T10:00:00Z');const s={driver_id:'A123456789',id_created_at:'2026-10-17T10:00:00Z'};assert.equal(betaLearning(s,now).overdue,false);assert.equal(betaLearning({...s,bgc_submitted_at:'2026-10-18T00:00:00Z'},now).overdue,true);assert.equal(betaLearning({...s,learning_status:'complete'},now).status,'pending');assert.equal(betaLearning({...s,learning_status:'complete',learning_confirmed_at:'2026-10-19T00:00:00Z'},now).status,'complete')});
test('one UAN email retains separate UAN and assisted-verification links',()=>{const actions=betaInboxActions([{sender:'operations@email.idfy.in',subject:'e-Shram UAN',action_urls:['https://360.idfy.com/noauth/example','https://capture.kyc.idfy.com/v2/captures?t=example','https://evil.test/']}]);assert.deepEqual(actions.map(x=>x.kind),['uan','assisted']);});
test('only a real verification action is shown; email body, logos and tracking links are omitted',()=>{
 const actions=betaInboxActions([{sender:'bgv-internal@idfy.com',subject:'Address Verification Request on Behalf of Amazon',preview:'Personal email contents. https://portal.idfy.com/tokens?p=example https://portal.idfy.com/images/idfylogo.png https://track.pstmrk.it/track'}]);
 assert.equal(actions.length,1);assert.equal(actions[0].kind,'verification');assert.equal(actions[0].label,'Open video verification link');assert.ok(!JSON.stringify(actions).includes('Personal email contents'));
});
test('UAN assisted links and unrelated messages never become video verification',()=>{
 const actions=betaInboxActions([{sender:'operations@email.idfy.in',subject:'Complete e-Shram',preview:'Get video assistance',action_url:'https://capture.kyc.idfy.com/v2/captures?t=uan'}, {sender:'bgv-internal@idfy.com',subject:'Your newsletter',action_url:'https://portal.idfy.com/tokens?p=unrelated'}]);
 assert.deepEqual(actions.map(a=>a.kind),['assisted']);
});
test('untrusted senders and non-action URL shapes are rejected',()=>{
 const template={sender:'IDfy <bgv-internal@idfy.com>',subject:'Video verification'};
 for(const url of ['http://portal.idfy.com/tokens?p=x','https://portal.idfy.com/tokens','https://portal.idfy.com.evil.test/tokens?p=x','https://evil@portal.idfy.com/tokens?p=x','https://portal.idfy.com:444/tokens?p=x','https://idfy.com/','https://portal.idfy.com/images/logo.png']) assert.deepEqual(betaInboxActions([{...template,action_url:url}]),[]);
 for(const sender of ['', 'person@example.test','support@notidfy.com','bgv@idfy.com.evil.test'])assert.deepEqual(betaInboxActions([{...template,sender,action_url:'https://portal.idfy.com/tokens?p=x'}]),[]);
});
test('newest verified link is selected first and duplicates are removed',()=>{
 const mail={sender:'bgv-internal@idfy.com',subject:'Address verification'};
 const actions=betaInboxActions([{...mail,action_url:'https://portal.idfy.com/tokens?p=old',received_at:'2026-10-10T01:00:00Z'}, {...mail,action_url:'https://portal.idfy.com/tokens?p=new',received_at:'2026-10-11T01:00:00Z'}, {...mail,action_url:'https://portal.idfy.com/tokens?p=new',received_at:'2026-10-10T02:00:00Z'}]);
 assert.equal(actions.length,2);assert.ok(actions[0].url.endsWith('p=new'));
});
function fixture({beta=true,preview=false}={}){
 const calls=[];const account={workspace:'workforce',profileType:'workforce',onboardingBeta:beta,activationStage:'amazon_email_pilot:sent',id:'selected-candidate',companyId:'selected-company'};
 const mocks={'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},'@/lib/connect-auth':{requireConnectAccount:async()=>account},'@/lib/connect-preview':{resolveConnectPreview:async()=>preview},'@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true}}}}}};
 const src=fs.readFileSync(new URL('../../app/api/connect/beta-verification/route.ts',import.meta.url),'utf8');const mod={exports:{}};
 new Function('require','module','exports',ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
 return {POST:mod.exports.POST,calls};
}
const req=()=>new Request('https://one.test/api/connect/beta-verification',{method:'POST',body:JSON.stringify({action:'address',caseId:'case-1',companyId:'attacker-company',candidateId:'attacker-candidate',details:{house:'Example'}})});
test('candidate response uses the authenticated beta identity, never body-supplied identity',async()=>{const f=fixture();assert.equal((await f.POST(req())).status,200);assert.equal(f.calls[0].args.p_candidate,'selected-candidate');assert.equal(f.calls[0].args.p_company,'selected-company');assert.equal(f.calls[0].args.p_case,'case-1')});
test('canonical users and view-as previews cannot change beta verification',async()=>{for(const options of [{beta:false},{preview:true}]){const f=fixture(options);assert.equal((await f.POST(req())).status,403);assert.equal(f.calls.length,0)}});

test('milestones require exact completed Amazon tasks, not merely a Driver ID',()=>{
 assert.equal(betaTaskComplete({driver_id:'A123456789'},'Accept Invitation'),false);
 assert.equal(betaTaskComplete({amazon_tasks:[{name:'Accept Invitation',status:'completed'}]},'Accept Invitation'),true);
 assert.equal(betaTaskComplete({amazon_tasks:[{name:'Account Setup',status:'not completed'}]},'Account Setup'),false);
});

test('message examples contain placeholders and no live links or candidate data',()=>{
 for(const example of Object.values(betaIdfyMessageExamples)){
  assert.match(example.greeting,/\[.+\]/);assert.match(example.address,/\[.+\]/);assert.match(example.link,/^\[.+\]$/);
  assert.doesNotMatch(JSON.stringify(example),/https?:|@|\d{6,}|Muhammed|Jamsheer|Yaz homes/i);
 }
});

test('beta inbox stays usable before migration; messages never masquerade as BGC checks',async()=>{
 const tables={
  workforce_amazon_email_pilot_candidates:[{id:'beta',company_id:'company',alias_email:'beta@example.test',mobile:'9000000000',closed_at:null,stations:{state:'Kerala'},continuation_status:'continuing'}],
  workforce_amazon_email_pilot_messages:[{id:'private-message',company_id:'company',candidate_id:'beta',sender:'bgv-internal@idfy.com',subject:'Address verification',preview:'PRIVATE EMAIL BODY',action_url:'https://portal.idfy.com/tokens?p=sample',received_at:'2026-10-11T10:00:00Z'},{id:'wrong-candidate',company_id:'company',candidate_id:'other',sender:'bgv-internal@idfy.com',subject:'Video verification',action_url:'https://portal.idfy.com/tokens?p=other',received_at:'2026-10-12T10:00:00Z'}],
  workforce_amazon_email_pilot_registrations:[{company_id:'company',candidate_id:'beta',status:'submitted'}]
 };
 const db={from(table){let rows=[...(tables[table]??[])],single=false;const q={
  select(columns){assert.ok(!columns.includes('action_urls'),'Must tolerate the pre-migration inbox schema');return q},
  eq(key,value){rows=rows.filter(row=>row[key]===value);return q},is(key,value){rows=rows.filter(row=>(row[key]??null)===value);return q},
  order(){return q},limit(){return q},maybeSingle(){single=true;return q},
  then(resolve,reject){return Promise.resolve({data:single?rows[0]??null:rows,error:table.startsWith('workforce_beta_verification_')?{code:'PGRST205'}:null}).then(resolve,reject)}
 };return q;}};
 const mocks={
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/beta-verification':verification,'@/lib/beta-journey':{betaJourney},'@/lib/onboarding-action-url':actionUrls,
  '@/lib/beta-exit-notice':{},'@/lib/amazon-pilot':{},'@/lib/partner-onboarding':{},'@/lib/workforce-joining':{},
  '@/lib/connect-auth':{requireConnectAccount:async()=>({id:'beta',companyId:'company',workspace:'workforce',activationOnly:true,onboardingBeta:true,activationStage:'amazon_email_pilot:sent'})},
  '@/lib/supabase-admin':{supabaseAdmin:db}
 };
 const mod={exports:{}};const source=fs.readFileSync(new URL('../../app/api/connect/workforce-joining/route.ts',import.meta.url),'utf8');
 new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
 const response=await mod.exports.GET({nextUrl:new URL('https://one.test/api/connect/workforce-joining?accountId=beta&profileType=workforce')});
 assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.inboxActions.length,1);assert.equal(result.inboxActions[0].url,'https://portal.idfy.com/tokens?p=sample');
 assert.deepEqual(result.bgcChecks,[]);assert.equal(result.syncDelayed,true);assert.equal(result.isolatedBeta,true);
 assert.ok(!JSON.stringify(result).includes('PRIVATE EMAIL BODY'));
});
