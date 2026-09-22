import test from 'node:test';
import assert from 'node:assert/strict';
import {canProcessPayment} from './payment-processing-policy.ts';
const scope={userId:'processor',hasAllLocationAccess:false,locationScopeIds:['station'],effectiveRoleIds:['finance']};
const request={location_id:'station',status:'approved',payment_process_role_ids:['finance']};
test('configured processor can handle an approved scoped request',()=>assert.equal(canProcessPayment(scope,request,false),true));
test('pending, returned, rejected and paid requests cannot enter processing',()=>{for(const status of ['pending','returned','rejected','processed']) assert.equal(canProcessPayment(scope,{...request,status},true),false);});
test('a processor needs the configured role and station',()=>{assert.equal(canProcessPayment(scope,{...request,location_id:'other'},false),false);assert.equal(canProcessPayment(scope,{...request,payment_process_role_ids:['other']},false),false);});
test('preview is never allowed to process money',()=>assert.equal(canProcessPayment({...scope,readOnly:true},request,true),false));
test('return assignment is respected even with general processor role',()=>assert.equal(canProcessPayment(scope,{...request,approval_status:'RE_APPROVED',current_approver_user_id:'other'},false),false));
test('processor-returned resubmission is processable by its assigned processor',()=>{
  const resubmitted={...request,status:'resubmitted',approval_status:'RE_APPROVED',current_approver_role_ids:['finance']};
  assert.equal(canProcessPayment(scope,resubmitted,false),true);
  assert.equal(canProcessPayment(scope,{...resubmitted,current_approver_role_ids:[],current_approver_user_id:'processor'},false),true);
  assert.equal(canProcessPayment(scope,{...resubmitted,current_approver_role_ids:['other']},false),false);
  assert.equal(canProcessPayment(scope,{...resubmitted,location_id:'other'},false),false);
  assert.equal(canProcessPayment({...scope,readOnly:true},resubmitted,true),false);
});
test('resubmission awaiting approval cannot enter processing, even for an owner',()=>{
  for(const approval_status of ['PENDING','APPROVED','FINAL_APPROVED',null]) {
    assert.equal(canProcessPayment(scope,{...request,status:'resubmitted',approval_status},true),false);
  }
});
