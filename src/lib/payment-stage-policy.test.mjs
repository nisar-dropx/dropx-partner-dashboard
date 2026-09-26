import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveInitialStage, initialStageStatus, hasInitialApprovalForStage, hasInitialApprovalForPersistedRequest, matchesCurrentPaymentAssignee, isPendingPaymentApproval, effectiveApprovalStepOrder} from './payment-stage-policy.ts';

const step=(order,role,scope='station',required=false)=>({step_order:order,candidates:[{role_id:role,scope}],is_required:required});
const steps=[step(1,'senior'),step(2,'cluster'),step(3,'business','company'),step(4,'finance','company',true)];
const target=role=>({userId:role+'-user',roleId:role});

test('master edits do not strand already-approved historical Finance queues',()=>{
  const revised=[step(1,'cluster'),step(2,'business','company',true)];
  assert.equal(hasInitialApprovalForPersistedRequest(revised,4,4,[{action:'approved',approver_role_id:'cluster'}]),true);
  assert.equal(hasInitialApprovalForPersistedRequest(revised,4,4,[]),false);
  assert.equal(hasInitialApprovalForPersistedRequest(revised,2,2,[]),false);
  assert.equal(hasInitialApprovalForPersistedRequest([],2,null,[]),true);
});

test('intermediate approvals stay visible on mobile; completed and processor queues do not',()=>{
  for (const [status,approval] of [['pending','PENDING'],['pending','APPROVED'],['OPERATIONS_CLM_APPROVED','OPERATIONS_CLM_APPROVED'],['resubmitted','RE_CLUSTER_APPROVED']])
    assert.equal(isPendingPaymentApproval(status,approval),true);
  for (const [status,approval] of [['approved','FINAL_APPROVED'],['processed','PROCESSED'],['resubmitted','RE_APPROVED'],['returned','RETURNED']])
    assert.equal(isPendingPaymentApproval(status,approval),false);
});

test('missing optional senior manager routes to cluster manager, not business head',async()=>{
  const result=await resolveInitialStage(steps,async s=>s.step_order===1?null:target(s.candidates[0].role_id));
  assert.equal(result.step.step_order,2);
  assert.equal(result.approver.roleId,'cluster');
  assert.equal(initialStageStatus(result.approver),'PENDING');
});
test('missing all initial managers cannot fall through to business head or finance',async()=>{
  const visited=[];
  const result=await resolveInitialStage(steps,async s=>{visited.push(s.step_order);return s.step_order<3?null:target('business');});
  assert.deepEqual(visited,[1,2]);
  assert.equal(result.step.step_order,2);
  assert.equal(result.approver,null);
  assert.equal(initialStageStatus(result.approver),'NO_APPROVER_CONFIGURED');
});
test('required local stage blocks fallback and permission-filtered stages stay local',async()=>{
  const result=await resolveInitialStage([{...steps[0],is_required:true},...steps.slice(1)],async()=>null);
  assert.equal(result.step.step_order,1);
  const filtered=await resolveInitialStage([{...steps[1],candidates:[],has_local_candidates:true},steps[2]],async s=>s.step_order===3?target('business'):null);
  assert.equal(filtered.step.step_order,2);
});
test('explicit company-only workflow remains supported, with no fabricated approval',async()=>{
  const result=await resolveInitialStage([steps[3]],async()=>target('finance'));
  assert.equal(result.approver.roleId,'finance');
  assert.equal(initialStageStatus(result.approver),'PENDING');
});
test('BH cannot act until a local approval is recorded; creation and rejection are not approvals',()=>{
  for(const logs of [[],[{action:'created',approver_role_id:'cluster'}],[{action:'rejected',approver_role_id:'cluster'}],[{action:'approved',approver_role_id:'business'}]])
    assert.equal(hasInitialApprovalForStage(steps,3,logs),false);
  assert.equal(hasInitialApprovalForStage(steps,3,[{action:'approved',approver_role_id:'cluster'}]),true);
  assert.equal(hasInitialApprovalForStage(steps,2,[]),true);
  assert.equal(hasInitialApprovalForStage([steps[3]],4,[]),true);
  assert.equal(hasInitialApprovalForStage(steps,99,[]),false);
});
test('broad roles do not override a named manager assignment, unnamed role pools work',()=>{
  const request={current_approver_user_id:'cluster-user',current_approver_role_ids:['cluster','business']};
  assert.equal(matchesCurrentPaymentAssignee('business-user',['business'],request),false);
  assert.equal(matchesCurrentPaymentAssignee('cluster-user',['cluster'],request),true);
  assert.equal(matchesCurrentPaymentAssignee('business-user',['business'],{...request,current_approver_user_id:null}),true);
});
test('repairs a stale step pointer when the assigned role belongs to one later step',()=>{
  assert.equal(effectiveApprovalStepOrder(steps,1,'business'),3);
});
test('does not infer a step when a role is reused at multiple levels',()=>{
  const ambiguous=[step(1,'area'),step(2,'area','company',true)];
  assert.equal(effectiveApprovalStepOrder(ambiguous,1,'area'),1);
});
test('keeps a valid stored step unchanged',()=>{
  assert.equal(effectiveApprovalStepOrder(steps,2,'cluster'),2);
});
test('routing on both surfaces no longer skips an approver based on roster availability',()=>{
  for(const file of ['./payment-approval-steps.ts','../../apps/connect/src/lib/payment-approval-steps.ts']) {
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/isApproverAvailable|hr_approval_email_is_working|hr_approval_email_workday/);
    assert.match(source,/redirectThroughDelegation/);
  }
});
