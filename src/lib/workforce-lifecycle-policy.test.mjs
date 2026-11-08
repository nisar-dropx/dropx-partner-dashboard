import test from 'node:test';
import assert from 'node:assert/strict';
import { mayManageWorkforceLifecycle,workforceLifecycleActions,lifecycleMobile } from './workforce-lifecycle-policy.ts';
test('any one authorized final approver can act; station and preview users cannot',()=>{
 for(const role of ['FINANCE_ACCOUNTS','FINANCE_HEAD','OPERATIONS_NH','OPERATIONS_MANAGING_PARTNER']) assert.equal(mayManageWorkforceLifecycle({roleCode:role}),true);
 for(const role of ['OPERATIONS_TL','FINANCE_LOCATION','WORKFORCE_CM']) assert.equal(mayManageWorkforceLifecycle({roleCode:role}),false);
 assert.equal(mayManageWorkforceLifecycle({isPreview:true},true),false);
 assert.equal(mayManageWorkforceLifecycle({readOnly:true,roleCode:'FINANCE_HEAD'}),false);
});
test('rejoining retains identity and has distinct activation eligibility',()=>{
 assert.deepEqual(workforceLifecycleActions({queue:'offboarded',onboarding_status:'active'}),['rejoin']);
 assert.deepEqual(workforceLifecycleActions({queue:'inactive',onboarding_status:'pending'}),['rejoin','offboard']);
 assert.ok(workforceLifecycleActions({queue:'inactive',onboarding_status:'active'}).includes('reactivate'));
 assert.deepEqual(workforceLifecycleActions({queue:'exit_pending',onboarding_status:'active'}),[]);
});
test('mobile lookup normalizes Indian country code without fuzzy name matching',()=>{
 assert.equal(lifecycleMobile('+91 98765 43210'),'9876543210');
 assert.equal(lifecycleMobile('9876543210'),'9876543210');
});
