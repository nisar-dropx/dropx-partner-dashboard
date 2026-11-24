import assert from 'node:assert/strict';
import test from 'node:test';
import {validPayoutPublicationPeriod,payoutPublicationPeriodLabel,payoutPeriodMonths} from './payout-publication-period.ts';

test('publication accepts exact valid daily, half-month, monthly and cross-month periods',()=>{
  for(const [start,end] of [['2026-11-01','2026-11-15'],['2026-11-16','2026-11-30'],['2026-10-16','2026-10-31'],['2026-11-04','2026-11-04'],['2026-10-29','2026-11-07'],['2028-02-01','2028-02-29']])
    assert.equal(validPayoutPublicationPeriod(start,end),true);
});
test('publication rejects reversed, non-calendar and malformed dates',()=>{
  for(const [start,end] of [['2026-11-16','2026-11-15'],['2026-02-29','2026-03-01'],['2026-11-31','2026-12-01'],['2026-13-01','2026-13-02'],['2026-1-01','2026-01-15'],['','']])
    assert.equal(validPayoutPublicationPeriod(start,end),false);
});
test('confirmation labels show the exact selected dates',()=>{
  assert.equal(payoutPublicationPeriodLabel('2026-11-01','2026-11-15'),'2026-11-01 to 2026-11-15');
  assert.equal(payoutPublicationPeriodLabel('2026-11-04','2026-11-04'),'2026-11-04');
});

test('bank clearance covers every touched month including year boundaries',()=>{
  assert.deepEqual(payoutPeriodMonths('2026-11-16','2026-11-30'),['2026-11']);
  assert.deepEqual(payoutPeriodMonths('2026-12-28','2027-02-04'),['2026-12','2027-01','2027-02']);
  assert.throws(()=>payoutPeriodMonths('2026-11-16','2026-11-01'),/valid payout date range/);
});
