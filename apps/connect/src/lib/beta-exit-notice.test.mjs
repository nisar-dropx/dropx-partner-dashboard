import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { acknowledgedBetaExitNote, betaExitNoticeVersion } from './beta-exit-notice.ts';

function fixture({beta=true,requiresNote=false}={}) {
 const state={queries:[],calls:[]};
 const account={workspace:'workforce',profileType:'workforce',id:'target',companyId:'company',onboardingBeta:beta,activationStage:beta?'amazon_email_pilot:pending':null};
 const db={from(table){state.queries.push(table);const filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},is(){return q},neq(){return q},async maybeSingle(){if(table==='workforce_onboarding_exit_reasons'){assert.deepEqual(filters,[['company_id','company'],['client_code','AMAZON'],['is_active',true],['id','reason']]);return {data:{id:'reason',requires_note:requiresNote}};}return {data:table==='workforce'?{id:'canonical'}:{continuation_status:'pending'}}}};return q},async rpc(name,args){state.calls.push({name,args});return {data:{ok:true}}}};
 const mocks={'@/lib/beta-exit-notice':{acknowledgedBetaExitNote},'@/lib/beta-journey':{},'@/lib/amazon-pilot':{},'@/lib/partner-onboarding':{},'@/lib/connect-auth':{requireConnectAccount:async()=>account},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/workforce-joining':{},'@/lib/onboarding-action-url':{},'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}}};
 const src=fs.readFileSync(new URL('../../app/api/connect/workforce-joining/route.ts',import.meta.url),'utf8');
 const mod={exports:{}};new Function('require','module','exports',ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
 return {...mod.exports,state};
}
function request(overrides={}){return new Request('https://one.example/api/connect/workforce-joining',{method:'POST',body:JSON.stringify({accountId:'target',profileType:'workforce',action:'not_continuing',reasonId:'reason',note:'',...overrides})})}
const ack={trainingPayoutAcknowledged:true,trainingPayoutNoticeVersion:betaExitNoticeVersion};
test('isolated exit requires explicit current notice acknowledgement, old clients cannot bypass',async()=>{for(const bad of [{},{trainingPayoutAcknowledged:'true'}, {...ack,trainingPayoutNoticeVersion:'old'}]){const f=fixture();assert.equal((await f.POST(request(bad))).status,400);assert.equal(f.state.calls.length,0);assert.ok(!f.state.queries.includes('workforce'));}});
test('required explanation cannot be replaced by generated acknowledgement text',async()=>{const f=fixture({requiresNote:true});assert.equal((await f.POST(request(ack))).status,400);assert.equal(f.state.calls.length,0)});
test('acknowledged exit is scoped to exact beta candidate and records notice with original note',async()=>{const f=fixture({requiresNote:true});assert.equal((await f.POST(request({...ack,note:'Test reason'}))).status,200);assert.equal(f.state.calls.length,1);const call=f.state.calls[0];assert.equal(call.name,'workforce_update_isolated_amazon_email_pilot_decision');assert.equal(call.args.p_candidate,'target');assert.equal(call.args.p_company,'company');assert.match(call.args.p_note,/^Test reason/);assert.ok(call.args.p_note.includes(betaExitNoticeVersion));assert.ok(!f.state.queries.includes('workforce'));});
test('normal onboarding behaviour is unchanged by beta notice',async()=>{const f=fixture({beta:false});assert.equal((await f.POST(request({note:'Original note'}))).status,200);assert.equal(f.state.calls[0].name,'workforce_submit_amazon_pilot_exit');assert.equal(f.state.calls[0].args.p_note,'Original note');assert.ok(!f.state.queries.includes('workforce_onboarding_exit_reasons'));});
test('continuing registration never requires an exit acknowledgement',async()=>{const f=fixture();assert.equal((await f.POST(request({action:'continue_amazon'}))).status,200);assert.equal(f.state.calls[0].args.p_action,'continue_amazon')});
test('bounded note fits existing beta exit record without truncating policy',()=>{assert.ok(acknowledgedBetaExitNote({acknowledged:true,version:betaExitNoticeVersion,note:'x'.repeat(700),requiresNote:false}).length<=1000);assert.throws(()=>acknowledgedBetaExitNote({acknowledged:true,version:betaExitNoticeVersion,note:'x'.repeat(701),requiresNote:false}),/700/)});
