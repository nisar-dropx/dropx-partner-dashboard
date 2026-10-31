import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFinanceProcessingAccess } from './payment-processing-access-policy.ts';
import { canProcessPayment, canReconcilePayment } from './payment-processing-policy.ts';

const full = { canView: true, canAdd: true, canEdit: true };
const dashboard = {
  userId: 'accounts-user', companyId: 'company-a', roleId: 'legacy-accounts', roleCode: 'ACCOUNTS',
  effectiveRoleIds: ['legacy-accounts'], isMasterOwner: false, hasAllLocationAccess: true,
  locationScopeIds: [], permissions: { payment_process: full, workforce_payouts: full }
};
const membership = { role_id: 'finance-executive', is_active: true, has_all_location_access: false, location_scope_ids: ['station-a'] };
const roles = [{ id: 'finance-executive', location_access_mode: 'role_based' }];
const grants = { payment_process: full, workforce_payouts: full };
const payment = { location_id: 'station-a', payment_process_role_ids: ['finance-executive'], status: 'processing' };
const resolve = (base = dashboard, members = [membership], activeRoles = roles, permissions = grants) =>
  applyFinanceProcessingAccess(base, members, activeRoles, permissions);

test('legacy Dashboard account reconciles using its configured Finance processor role', () => {
  assert.equal(canReconcilePayment(dashboard, payment, false), false);
  const resolved = resolve();
  assert.equal(canReconcilePayment(resolved, payment, false), true);
  assert.deepEqual(resolved.effectiveRoleIds, ['finance-executive']);
  assert.equal(resolved.roleId, 'finance-executive');
  assert.equal(resolved.userId, dashboard.userId);
  assert.equal(resolved.companyId, dashboard.companyId);
  assert.equal(resolved.isMasterOwner, false);
  assert.equal(resolved.permissions.payment_process.canEdit, true);
});

test('Finance locations restrict legacy Dashboard all-location access', () => {
  const resolved = resolve();
  assert.equal(resolved.hasAllLocationAccess, false);
  assert.deepEqual(resolved.locationScopeIds, ['station-a']);
  assert.equal(canReconcilePayment(resolved, {...payment, location_id:'station-b'}, false), false);
  assert.equal(canReconcilePayment(resolved, {...payment, location_id:null}, false), false);
});

test('scoped Dashboard and Finance access intersect instead of merging', () => {
  const resolved = resolve({...dashboard, hasAllLocationAccess:false, locationScopeIds:['station-a','station-b']},
    [{...membership, location_scope_ids:['station-a','station-c']}]);
  assert.deepEqual(resolved.locationScopeIds, ['station-a']);
  for (const location_id of ['station-b','station-c']) assert.equal(canReconcilePayment(resolved, {...payment,location_id},false), false);
});

test('Finance all-location settings cannot widen scoped Dashboard access', () => {
  const base = {...dashboard,hasAllLocationAccess:false,locationScopeIds:['station-a']};
  for (const resolved of [resolve(base,[{...membership,has_all_location_access:true}]),
    resolve(base,[membership],[{...roles[0],location_access_mode:'all_locations'}])]) {
    assert.equal(resolved.hasAllLocationAccess,false);
    assert.deepEqual(resolved.locationScopeIds,['station-a']);
  }
  assert.equal(resolve(dashboard,[{...membership,has_all_location_access:true}]).hasAllLocationAccess,true);
});

test('disabled memberships, missing role IDs and inactive roles never fall back to legacy roles', () => {
  for (const resolved of [resolve(dashboard,[{...membership,is_active:false}]),
    resolve(dashboard,[{...membership,role_id:null}]), resolve(dashboard,[membership],[])]) {
    assert.deepEqual(resolved.effectiveRoleIds,[]);
    assert.equal(resolved.roleId,null);
    assert.equal(resolved.permissions.payment_process.canEdit,false);
    assert.equal(canReconcilePayment(resolved,payment,false),false);
  }
  assert.equal(resolve(dashboard,[]),dashboard);
});

test('both page grants are required; workforce permissions are not inherited from payment permission', () => {
  assert.equal(resolve(dashboard,[membership],roles,{}).permissions.payment_process.canEdit,false);
  assert.equal(resolve({...dashboard,permissions:{payment_process:{...full,canEdit:false}}}).permissions.payment_process.canEdit,false);
  const resolved = resolve(dashboard,[membership],roles,{payment_process:full});
  assert.equal(resolved.permissions.payment_process.canEdit,true);
  assert.equal(resolved.permissions.workforce_payouts.canEdit,false);
});

test('preview, approval state, assigned processor and exact replay protections remain intact', () => {
  assert.equal(canReconcilePayment(resolve({...dashboard,readOnly:true}),payment,false),false);
  const resolved=resolve();
  assert.equal(canReconcilePayment(resolved,{...payment,payment_process_role_ids:['other-finance-role']},false),false);
  for(const status of ['pending','rejected','submitted']) assert.equal(canReconcilePayment(resolved,{...payment,status},false),false);
  assert.equal(canReconcilePayment(resolved,{...payment,status:'paid'},false),true);
  assert.equal(canProcessPayment(resolved,{...payment,status:'paid'},false),false);
  assert.equal(canProcessPayment(resolved,{...payment,approval_status:'RE_APPROVED',current_approver_user_id:'another'},false),false);
});
