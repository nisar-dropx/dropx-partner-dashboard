import test from 'node:test';
import assert from 'node:assert/strict';
import { canOverseePayment, paymentPendingAge } from './payment-oversight-policy.ts';
import { resolvePaymentCover, paymentRoutingDay } from './payment-delegation-policy.ts';
import { matchesCurrentPaymentAssignee, hasInitialApprovalForStage } from './payment-stage-policy.ts';
import { isPendingPaymentApproval } from './payment-pending-approval.ts';
import { buildPaymentApprovalFlow } from './payment-approval-flow.ts';

const auth = { hasAllLocationAccess:false, locationScopeIds:['NLRE'], permissions:{payment_approvals:{canView:true}} };
test('approval-page access can track first-stage and completed requests in scope without becoming an approver', () => {
  for (const status of ['PENDING','FINAL_APPROVED','PROCESSED']) {
    const request={ location_id:'NLRE', status, current_approver_user_id:'cluster-manager' };
    assert.equal(canOverseePayment(auth,request),true);
    assert.equal(matchesCurrentPaymentAssignee('head-operations',['hlm'],request),false);
  }
  assert.equal(canOverseePayment(auth,{location_id:'JDBD'}),false);
  assert.equal(canOverseePayment(auth,{location_id:null}),false);
  assert.equal(canOverseePayment({...auth,permissions:{}},{location_id:'NLRE'}),false);
  assert.equal(canOverseePayment({...auth,locationScopeIds:[]},{location_id:'NLRE'}),false);
});
test('tracking inherits approval-page access without a separate grant', () => {
  const request={location_id:'NLRE'};
  assert.equal(canOverseePayment({...auth,permissions:{payment_oversight:{canView:true}}},request),false);
  assert.equal(canOverseePayment({...auth,permissions:{payment_approvals:{canView:false,canEdit:true}}},request),true);
  assert.equal(canOverseePayment({...auth,permissions:{payment_approvals:{canView:false,canAdd:true}}},request),true);
  assert.equal(canOverseePayment({...auth,permissions:{payment_approvals:{canView:false,canAdd:false,canEdit:false}}},request),false);
});
test('approval and processing terminal states cannot appear as actionable just because an assignee was retained',()=>{
  for(const status of ['FINAL_APPROVED','OWNER_APPROVED','RE_APPROVED','PROCESSED','PROCESSING','RETURNED','REJECTED','CANCELLED'])
    assert.equal(isPendingPaymentApproval({approval_status:status,current_approver_user_id:'old'}),false,status);
  assert.equal(isPendingPaymentApproval({status:'approved',approval_status:'APPROVED',current_approver_user_id:'old'}),false);
  assert.equal(isPendingPaymentApproval({status:'pending',approval_status:'APPROVED',current_approver_user_id:'aom'}),true);
  assert.equal(isPendingPaymentApproval({approval_status:'NO_APPROVER_CONFIGURED'}),true);
});
test('leave dates and waiting time use real timestamps across the IST midnight boundary',()=>{
  assert.equal(paymentRoutingDay(new Date('2026-10-13T18:31:00Z')),'2026-10-14');
  assert.equal(paymentRoutingDay(new Date('2026-10-13T18:29:00Z')),'2026-10-13');
  assert.equal(paymentPendingAge('2026-10-12T10:00:00Z',new Date('2026-10-14T11:00:00Z')),'2d 1h pending');
  assert.equal(paymentPendingAge(null),'Time unavailable');
});
const person=(name,delegateUserId=null,extra={})=>({name,delegateUserId,canAct:true,unavailable:false,...extra});
test('approved cover follows two absent approvers to a qualified substitute',async()=>{
  const people={cm:person('Cluster','aom',{unavailable:true}),aom:person('AOM','bh',{unavailable:true}),bh:person('Business Head')};
  assert.deepEqual(await resolvePaymentCover('cm',async id=>people[id]),{userId:'bh',routingReason:'Leave / acting cover: Cluster → AOM → Business Head'});
});
test('invalid scope, missing cover, conflicting cover and circular delegation yield no assignee',async()=>{
  for(const extra of [{canAct:false},{unavailable:true},{conflictingCover:true}]) assert.equal(await resolvePaymentCover('cm',async()=>person('CM',null,extra)),null);
  assert.equal(await resolvePaymentCover('cm',async id=>person(id,id==='cm'?'aom':'cm')),null);
});
test('old optional stages do not duplicate an AOM approval or misattribute the final decision',()=>{
  const levels=[{stepOrder:1,roleIds:['cm','aom']},{stepOrder:2,roleIds:['aom']},{stepOrder:3,roleIds:['bh']}];
  const logs=[{action:'approved',approver_user_id:'sujan',approver_role_id:'aom',created_at:'2026-10-14T08:00:00Z'},{action:'approved',approver_user_id:'ujjal',approver_role_id:'bh',created_at:'2026-10-14T09:00:00Z'}];
  const flow=buildPaymentApprovalFlow({status:'approved',approval_status:'FINAL_APPROVED',current_step_order:3},levels,[],logs);
  assert.equal(flow[0].approvedByUserId,'sujan');assert.equal(flow[1].state,'skipped');assert.equal(flow[1].approvedByUserId,null);assert.equal(flow[2].approvedByUserId,'ujjal');
});
test('acting cover is attached to its recorded stage despite a different personal role',()=>{
  const flow=buildPaymentApprovalFlow({status:'pending',approval_status:'PENDING',current_step_order:3},[{stepOrder:1,roleIds:['cm']},{stepOrder:3,roleIds:['bh']}],[],[{action:'approved',approval_step_order:1,approver_user_id:'cover',approver_role_id:'hlm',created_at:'2026-10-14'}]);
  assert.equal(flow[0].approvedByUserId,'cover');assert.equal(flow[1].state,'current');
});

test('acting approval satisfies its recorded required stage without granting another-stage bypass',()=>{
  const steps=[{step_order:1,is_required:true,candidates:[{role_id:'cm',scope:'station'}]},{step_order:2,is_required:true,candidates:[{role_id:'bh',scope:'company'}]}];
  assert.equal(hasInitialApprovalForStage(steps,2,[{action:'approved',approver_role_id:'hlm',approval_step_order:1}]),true);
  assert.equal(hasInitialApprovalForStage(steps,2,[{action:'approved',approver_role_id:'cm',approval_step_order:2}]),false);
});
