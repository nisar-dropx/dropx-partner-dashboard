import test from 'node:test';
import assert from 'node:assert/strict';
import {betaUanProgress,loadBetaUanMail,retainBetaUanProgress} from './beta-uan.ts';
import {betaMilestones} from './beta-onboarding-progress.ts';
const mail={id:'confirmation',sender:'no-reply@logistics.amazon.in',subject:'Your UAN has been verified',preview:'Your Universal Account Number (UAN) has been successfully verified. Thank you for completing this requirement.',received_at:'2026-10-16T11:27:48Z'};
const request={id:'request',sender:'operations@email.idfy.in',subject:'Action Required: Complete your e-Shram registration',preview:'Submit your UAN',received_at:'2026-10-11T03:00:00Z'};
test('actual Amazon confirmation resolves an empty UAN snapshot and older IDfy request',()=>{
 const result=betaUanProgress({uan_status:null},[request,mail]);
 assert.deepEqual(result,{status:'verified',source:'Amazon email',updatedAt:mail.received_at,messageId:'confirmation'});
 const account=betaMilestones({isolatedBeta:true,stage:'amazon_registration',amazonRegistrationConfirmed:true,uan:result,inboxActions:[{kind:'uan'}]}).find(s=>s.id==='account');
 assert.equal(account.status,'complete');assert.match(account.detail,/UAN is verified/);
});
test('untrusted senders, unrelated completions and negated messages cannot confirm UAN',()=>{
 for(const altered of [{sender:'no-reply@logistics.amazon.in.evil.com'},{sender:'other@example.com'},{subject:'UAN has not been verified'},{preview:'Your UAN is not verified.'},{subject:'Drivers License Verification Complete Notification'},{received_at:'invalid'}])assert.notEqual(betaUanProgress(null,[{...mail,...altered}]).status,'verified');
});
test('a repeated reminder or pending snapshot never reverses confirmation',()=>{
 assert.equal(betaUanProgress({uan_status:'pending',idfy_observed_at:'2026-10-17T10:00:00Z'},[mail,{...request,received_at:'2026-10-17T11:00:00Z'}]).status,'verified');
});
test('submission is review pending, not verified; a newer specific rejection reopens action',()=>{
 const submittedAt='2026-10-16T12:00:00Z';
 assert.equal(betaUanProgress(null,[request],submittedAt).status,'submitted');
 assert.equal(betaUanProgress(null,[mail],submittedAt).status,'verified');
 const rejected={...mail,subject:'UAN verification failed',preview:'Your UAN could not be verified.',received_at:'2026-10-17T10:00:00Z'};
 assert.equal(betaUanProgress(null,[rejected,mail]).status,'action_required');
 assert.equal(betaUanProgress(null,[rejected,mail],'2026-10-17T11:00:00Z').status,'submitted');
});
test('UAN confirmation and Amazon account setup remain separate milestones',()=>{
 const data={isolatedBeta:true,stage:'invited',uan:{status:'verified'},inboxActions:[]};
 assert.notEqual(betaMilestones(data).find(s=>s.id==='setup').status,'complete');
 assert.equal(betaMilestones({...data,accountSetupConfirmed:true}).find(s=>s.id==='setup').status,'complete');
});

test('IDfy request is actionable, while submission removes the repeat action',()=>{
 const requested=betaUanProgress(null,[request]);assert.equal(requested.status,'requested');
 const input={isolatedBeta:true,stage:'amazon_registration',amazonRegistrationConfirmed:true,inboxActions:[{kind:'uan'}]};
 assert.equal(betaMilestones({...input,uan:requested}).find(s=>s.id==='account').status,'action');
 assert.equal(betaMilestones({...input,uan:{status:'submitted'}}).find(s=>s.id==='account').status,'in_progress');
 assert.equal(betaMilestones({...input,uan:{status:'verified'},learning:{status:'action'}}).find(s=>s.status==='action'&&s.id==='activation').id,'activation');
});

test('missing email can use explicit dated UAN status, never BGC or account activation',()=>{
 assert.equal(betaUanProgress({uan_status:'approved',lsc_observed_at:mail.received_at},[]).status,'verified');
 assert.equal(betaUanProgress({uan_status:'submitted',idfy_observed_at:mail.received_at},[]).status,'submitted');
 for(const snapshot of [{uan_status:'verified'},{bgc_status:'green',operational_status:'ACTIVE',driver_id:'A123',lsc_observed_at:mail.received_at},{uan_status:'pending',idfy_observed_at:mail.received_at}])assert.equal(betaUanProgress(snapshot,[]).status,'unknown');
});
test('submission receipts remain pending and ambiguous mail formats never verify',()=>{
 const receipt={...request,subject:'UAN submission received',preview:'Your UAN has been received for review.'};
 assert.equal(betaUanProgress(null,[receipt]).status,'submitted');
 assert.equal(betaUanProgress(null,[{...mail,subject:'UAN status update',preview:'Your request is processed.'}]).status,'unknown');
 const rejected={...mail,subject:'UAN verification failed'};
 assert.equal(betaUanProgress(null,[mail,rejected]).status,'action_required');
});
test('an unavailable source retains the last known result, not a fabricated completion',()=>{
 const verified=betaUanProgress(null,[mail]),unknown={...betaUanProgress(null,[]),syncDelayed:true};
 assert.equal(retainBetaUanProgress(unknown,verified).status,'verified');
 assert.equal(retainBetaUanProgress(unknown).status,'unknown');
 assert.equal(retainBetaUanProgress({...unknown,status:'action_required'},verified).status,'action_required');
 assert.equal(retainBetaUanProgress({...unknown,status:'submitted'},verified).status,'submitted');
});

function mailStore(rows,failRecent=false){
 return {from(table){assert.equal(table,'workforce_amazon_email_pilot_messages');let selected=[...rows],limit=Infinity,recent=false;const q={
  select(){return q},eq(k,v){selected=selected.filter(r=>r[k]===v);return q},order(){selected.sort((a,b)=>b.received_at.localeCompare(a.received_at));return q},
  or(){recent=true;selected=selected.filter(r=>/uan|shram/i.test(r.subject));return q},
  ilike(k,pattern){const prefix=pattern.replace(/%$/,'').toLowerCase();selected=selected.filter(r=>r[k].toLowerCase().startsWith(prefix));return q},
  limit(n){limit=n;return q},then(resolve,reject){return Promise.resolve({data:recent&&failRecent?null:selected.slice(0,limit),error:recent&&failRecent?{code:'unavailable'}:null}).then(resolve,reject)}
 };return q}};
}
test('old confirmation survives over 100 reminders and another candidate or company cannot contribute',async()=>{
 const scoped=r=>({...r,company_id:'company',candidate_id:'candidate'});
 const rows=[scoped(mail),...Array.from({length:120},(_,i)=>scoped({...request,id:'reminder-'+i,received_at:'2026-10-17T11:00:00Z'})),{...mail,company_id:'other',candidate_id:'candidate'},{...mail,company_id:'company',candidate_id:'other'}];
 const result=await loadBetaUanMail(mailStore(rows),'company','candidate');
 assert.equal(result.unavailable,false);assert.equal(betaUanProgress(null,result.messages).status,'verified');
 assert.ok(result.messages.every(m=>m.company_id==='company'&&m.candidate_id==='candidate'));
 assert.equal((await loadBetaUanMail(mailStore(rows),'company','new-account')).messages.length,0);
 const partial=await loadBetaUanMail(mailStore(rows,true),'company','candidate');
 assert.equal(partial.unavailable,true);assert.equal(betaUanProgress(null,partial.messages).status,'verified');
});

// Exercise the authenticated write boundary: it records only a candidate declaration.
import fs from 'node:fs';
import ts from 'typescript';
function submissionRoute(allowed=true){
 const writes=[];
 const mocks={
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/beta-private-account':{requireBetaPrivateAccount:async()=>{if(!allowed)throw Error('Denied');return {account:{id:'own-beta',companyId:'own-company'},db:{from(table){assert.equal(table,'workforce_beta_verification_events');return {insert:async row=>{writes.push(row);return {error:null}}}}}}}}
 };
 const mod={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL('../../app/api/connect/beta-uan/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},mod,mod.exports);
 return {POST:mod.exports.POST,writes};
}
test('submission uses signed-in identity and cannot verify UAN or mutate another account',async()=>{
 const f=submissionRoute();const response=await f.POST({json:async()=>({action:'submitted',candidateId:'other',companyId:'other',status:'verified'})});
 assert.equal(response.status,200);assert.deepEqual(f.writes,[{company_id:'own-company',candidate_id:'own-beta',event:'uan_submission_reported',detail:{source:'candidate'}}]);
 const denied=submissionRoute(false);assert.equal((await denied.POST({json:async()=>({action:'submitted'})})).status,403);assert.equal(denied.writes.length,0);
 const invalid=submissionRoute();assert.equal((await invalid.POST({json:async()=>({action:'verified'})})).status,400);assert.equal(invalid.writes.length,0);
});
