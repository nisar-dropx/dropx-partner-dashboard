import assert from 'node:assert/strict';
import test from 'node:test';
import { connectApprovalSection } from './connect-approval-links.ts';
import { connectAccountRoute } from './connect-account-routing.ts';
import { payAdvanceDecision } from './connect-pay-advance-approval.ts';

test('approval email categories survive account selection without changing account identity', () => {
  const account = {id:'manager-a',companyId:'company-a',profileType:'employee',reference:'SHARED500'};
  const url = new URL(connectAccountRoute('/approvals', account, connectApprovalSection('reimbursements')), 'https://one.example.com');
  assert.equal(url.pathname,'/approvals');
  assert.equal(url.searchParams.get('section'),'reimbursements');
  assert.equal(url.searchParams.get('account'),'employee:company-a:manager-a');
  assert.equal(connectAccountRoute('/approvals', null, 'time-off'),'/approvals?section=time-off');
  assert.equal(new URL(connectAccountRoute('/dashboard',account,'reimbursements'),'https://one.example.com').searchParams.has('section'),false);
});
test('unknown categories cannot become an external return URL', () => {
  for (const value of ['https://evil.example', '//evil.example', 'rostering', '', null]) assert.equal(connectApprovalSection(value),null);
  assert.equal(connectApprovalSection('pay-advances'),'pay-advances');
});
test('pay-advance decisions require a supported action and a rejection reason', () => {
  assert.deepEqual(payAdvanceDecision('approved',''),{decision:'approved',note:null});
  assert.deepEqual(payAdvanceDecision('rejected','  Please correct the amount  '),{decision:'rejected',note:'Please correct the amount'});
  assert.throws(()=>payAdvanceDecision('disbursed',''),/Approve or Reject/);
  assert.throws(()=>payAdvanceDecision('rejected',' '),/reason/);
  assert.throws(()=>payAdvanceDecision('approved','x'.repeat(501)),/500/);
});
