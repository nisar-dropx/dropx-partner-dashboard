import test from 'node:test';
import assert from 'node:assert/strict';
import { requesterSafeSteps } from './payment-requester-routing.ts';
import { resolveInitialStage, hasInitialApprovalForStage } from './payment-stage-policy.ts';
import { eligibleExpenseVehicle, parsePaymentVehicleScope } from './payment-vehicle-policy.ts';
const stage=(order,role,scope='company')=>({id:String(order),step_order:order,candidates:[{role_id:role,scope}],is_required:true});
const target=(user,role)=>({userId:user,roleId:role});

test('Fleet requester routes to independent final review without an invented approval',async()=>{
 const stages=[stage(1,'fleet'),stage(2,'business')];
 const result=await requesterSafeSteps(stages,'requester',async(s,exclude)=>s.step_order===1?(exclude?null:target('requester','fleet')):target('head','business'));
 assert.deepEqual(result.skipped,[{step_order:1,role_id:'fleet',reason:'requester_is_approver'}]);
 assert.equal(result.steps.length,1);
 assert.equal(result.steps[0].candidates[0].role_id,'business');
 assert.equal(result.steps[0].step_order,1);
 assert.equal(hasInitialApprovalForStage(result.steps,1,[]),true);
 assert.equal(stages.length,2);
});
test('other eligible candidate retains the configured stage',async()=>{
 const result=await requesterSafeSteps([stage(1,'fleet'),stage(2,'business')],'requester',async(s,exclude)=>target(s.step_order===1?(exclude?'alternate':'requester'):'head',s.candidates[0].role_id));
 assert.equal(result.skipped.length,0);assert.equal(result.steps.length,2);
});
test('required unassigned local stage is never mistaken for a requester stage',async()=>{
 const stages=[stage(1,'cluster','station'),stage(2,'business')];
 const result=await requesterSafeSteps(stages,'requester',async s=>s.step_order===1?null:target('head','business'));
 assert.equal(result.skipped.length,0);
 const initial=await resolveInitialStage(result.steps,async s=>s.step_order===1?null:target('head','business'));
 assert.equal(initial.approver,null);assert.equal(initial.step.step_order,1);
 assert.equal(hasInitialApprovalForStage(result.steps,2,[]),false);
});
test('self-only final stage is blocked even when earlier stages exist',async()=>{
 await assert.rejects(()=>requesterSafeSteps([stage(1,'fleet'),stage(2,'head')],'requester',async(s,exclude)=>exclude?null:target('requester',s.candidates[0].role_id)),/independent final approver/);
});
test('vehicle eligibility includes maintenance but excludes outside ownership and scope',()=>{
 const vehicle={id:'v',vehicle_no:'TEST01',model:'Test van',station_code:'TEST',status:'breakdown',ownership_type:'own'};
 assert.equal(eligibleExpenseVehicle(vehicle,'TEST'),true);
 assert.equal(eligibleExpenseVehicle({...vehicle,status:'under_service'},'TEST'),true);
 for(const ownership_type of ['odcd','rented','vendor','unknown']) assert.equal(eligibleExpenseVehicle({...vehicle,ownership_type},'TEST'),false);
 assert.equal(eligibleExpenseVehicle(vehicle,'OTHER'),false);
 for(const status of ['inactive','sold','disposed','returned'])assert.equal(eligibleExpenseVehicle({...vehicle,status},'TEST'),false);
 assert.equal(parsePaymentVehicleScope(null),'none');
 assert.equal(parsePaymentVehicleScope('owned_station'),'owned_station');
 assert.throws(()=>parsePaymentVehicleScope('all'),/valid vehicle requirement/);
});
