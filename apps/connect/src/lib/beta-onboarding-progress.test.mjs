import {test} from 'node:test';
import assert from 'node:assert/strict';
import {betaMilestones} from './beta-onboarding-progress.ts';
const profile={isolatedBeta:true,stage:'amazon_registration',registrationStatus:'submitted',continuationStatus:'continuing',amazonRegistrationConfirmed:true,bgcStatus:'Green',bgcChecks:[{status:'complete'}],inboxActions:[{kind:'uan'}],driverId:'A123456789',learning:{status:'action'}};
test('confirmed Flex and green BGC show remaining UAN/training actions',()=>{
 const stages=betaMilestones(profile),byId=Object.fromEntries(stages.map(s=>[s.id,s]));
 assert.equal(byId.amazon.status,'complete');assert.equal(byId.bgc.status,'complete');
 assert.equal(byId.account.status,'action');assert.equal(byId.activation.status,'action');
 assert.equal(byId.attendance.status,'in_progress');
 assert.equal(stages.find(s=>s.status==='action').id,'account');
});
test('an outstanding check overrides overall green; missing checks are not cleared by driver ID',()=>{
 assert.equal(betaMilestones({...profile,bgcChecks:[{status:'action'}]}).find(s=>s.id==='bgc').status,'action');
 assert.equal(betaMilestones({...profile,bgcStatus:null,bgcChecks:[]}).find(s=>s.id==='bgc').status,'in_progress');
});
test('readiness alone does not invent biometric attendance',()=>{
 const input={...profile,amazonRegistrationConfirmed:false,bgcStatus:null,learning:undefined,inboxActions:[]};
 assert.equal(betaMilestones(input).find(s=>s.id==='attendance').status,'in_progress');
 assert.equal(betaMilestones({...input,latestAttendance:{inTime:'09:00',outTime:'18:00'}}).find(s=>s.id==='attendance').status,'complete');
});
test('beta LM training completes without requiring a first delivery',()=>{
 assert.equal(betaMilestones({...profile,learning:{status:'complete'}}).find(s=>s.id==='activation').status,'complete');
 assert.equal(betaMilestones({...profile,learning:{status:'complete'},stage:'delivery_started'}).find(s=>s.id==='activation').status,'complete');
});

test('a historical UAN message cannot override confirmed Amazon account setup',()=>{const steps=betaMilestones({isolatedBeta:true,stage:'invited',accountSetupConfirmed:true,inboxActions:[{kind:'uan'}]});assert.equal(steps.find(s=>s.id==='setup').status,'complete');});

test('separate milestones apply only to isolated beta accounts',()=>{
 assert.equal(betaMilestones({...profile,isolatedBeta:false}).length,6);
 const beta=betaMilestones({...profile,uan:{status:'verified'}});
 assert.equal(beta.length,7);assert.equal(beta.find(s=>s.id==='account').status,'complete');
 assert.equal(beta.find(s=>s.id==='setup').status,'in_progress');
 assert.equal(beta.find(s=>s.status==='action').id,'activation');
});
