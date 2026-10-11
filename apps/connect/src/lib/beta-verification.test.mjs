import {test} from 'node:test';
import assert from 'node:assert/strict';
import {betaLearning,betaTaskComplete,betaInboxActions,verifiedBetaSnapshot,verificationState} from './beta-verification.ts';
import fs from 'node:fs';
import ts from 'typescript';
test('verification failures and negations never become green',()=>{for(const s of ['not verified','verified_red','insufficient','not completed'])assert.notEqual(verificationState(s),'complete');assert.equal(verificationState('Green'),'complete');});
test('a different provider or email cannot supply a candidate status',()=>{const s={amazon_profile_id:'p1',identity_email:'one@example.test'};assert.equal(verifiedBetaSnapshot(s,'two@example.test','p1'),null);assert.equal(verifiedBetaSnapshot(s,'one@example.test','p2'),null);assert.equal(verifiedBetaSnapshot(s,'ONE@example.test','p1'),s)});
test('LM deadline uses actual creation evidence and waits for BGC submission',()=>{const now=Date.parse('2026-10-20T10:00:00Z');const s={driver_id:'A123456789',id_created_at:'2026-10-17T10:00:00Z'};assert.equal(betaLearning(s,now).overdue,false);assert.equal(betaLearning({...s,bgc_submitted_at:'2026-10-18T00:00:00Z'},now).overdue,true);assert.equal(betaLearning({...s,learning_status:'complete'},now).status,'pending');assert.equal(betaLearning({...s,learning_status:'complete',learning_confirmed_at:'2026-10-19T00:00:00Z'},now).status,'complete')});
test('one UAN email retains separate UAN and assisted-verification links',()=>{const actions=betaInboxActions([{subject:'e-Shram UAN',action_urls:['https://360.idfy.com/noauth/example','https://capture.kyc.idfy.com/v2/captures?t=example','https://evil.test/']}]);assert.deepEqual(actions.map(x=>x.kind),['uan','assisted']);});
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
