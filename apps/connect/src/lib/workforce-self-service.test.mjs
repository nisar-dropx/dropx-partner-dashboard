import test from 'node:test';
import assert from 'node:assert/strict';
import { withWorkforceSelfServicePages, workforceSelfServicePages } from './dropx-one-pages.ts';

test('normal workforce has all self-service menus independent of designation configuration',()=>{
  for(const profileType of ['workforce','field_executive','worker','vendor']){
    const actual=withWorkforceSelfServicePages(['profile','settings'],{profileType,workspace:'workforce'});
    for(const page of workforceSelfServicePages)assert.ok(actual.includes(page),`${profileType} ${page}`);
    for(const page of ['approvals','reimbursements','wfh','business_trip'])assert.ok(!actual.includes(page));
    assert.equal(new Set(actual).size,actual.length);
  }
});
test('People, manager and activation-only accounts are not broadened',()=>{
  for(const account of [{profileType:'employee',workspace:'people'},{profileType:'contractor',workspace:'people'},
    {profileType:'user',workspace:'workforce'},{profileType:'workforce',workspace:'workforce',activationOnly:true}]){
    assert.deepEqual(withWorkforceSelfServicePages(['profile'],account),['profile']);
  }
});
