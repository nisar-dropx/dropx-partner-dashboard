import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPaymentWorkHours as hours, withinPaymentWorkHours, nextPaymentReminder, paymentThreadMonth, validatePaymentWorkHours } from './payment-reminder-policy.ts';
import { isPendingPaymentApproval } from './payment-stage-policy.ts';

test('work hours include opening and exclude closing in IST', () => {
  assert.equal(withinPaymentWorkHours(new Date('2026-09-22T03:30:00Z'), hours), true);
  assert.equal(withinPaymentWorkHours(new Date('2026-09-22T12:30:00Z'), hours), false);
  assert.equal(withinPaymentWorkHours(new Date('2026-09-22T03:29:00Z'), hours), false);
});
test('90 minute interval, overnight deferral, weekend deferral', () => {
  assert.equal(nextPaymentReminder(new Date('2026-09-22T04:00:00Z'),90,hours), '2026-09-22T05:30:00.000Z');
  assert.equal(nextPaymentReminder(new Date('2026-09-22T12:00:00Z'),90,hours), '2026-09-23T03:30:00.000Z');
  assert.equal(nextPaymentReminder(new Date('2026-09-25T12:00:00Z'),90,{...hours,days:[1,2,3,4,5]}), '2026-09-28T03:30:00.000Z');
});
test('month uses configured local timezone, not UTC', () => {
  assert.equal(paymentThreadMonth(new Date('2026-09-30T19:00:00Z'),'Asia/Kolkata'),'2026-10-01');
});
test('initial and intermediate approvals remain pending; decisions stop reminders', () => {
  for (const s of ['pending','resubmitted','OPERATIONS_CLM_APPROVED','OPERATIONS_BH_APPROVED']) assert.equal(isPendingPaymentApproval(s,s), true);
  for (const s of ['approved','processed','processing','returned','rejected','cancelled']) assert.equal(isPendingPaymentApproval(s,s), false);
  assert.equal(isPendingPaymentApproval('pending','FINAL_APPROVED'), false);
});
test('invalid work windows and empty days are rejected', () => {
  assert.throws(()=>validatePaymentWorkHours({...hours, days:[]}));
  assert.throws(()=>validatePaymentWorkHours({...hours, start:'18:00',end:'09:00'}));
  assert.throws(()=>validatePaymentWorkHours({...hours, timezone:'invalid'}));
});
