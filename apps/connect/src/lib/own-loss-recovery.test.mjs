import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ownLossRecoveryEstimate} from './own-loss-recovery.ts';

const line={recovery_key:'sep|shipment|workforce:da',month:'2026-09',case_key:'shipment',report:'nl',worker_id:'da',employee_code:'D1',amount:1912,deduction_month:'2026-10',label:'NL loss',cap_percent:50};

test('own approved due line reduces estimate exactly once; other people excluded',()=>{
  const r=ownLossRecoveryEstimate('da',15729,0,[line,line,{...line,worker_id:'other',recovery_key:'other'}]);
  assert.equal(r.lossRecoveryAmount,1912);
  assert.equal(r.deductionAmount,1912);
  assert.equal(r.netAmount,13817);
});

test('available-pay limits defer whole lines that do not fit; empty plans leave other deductions',()=>{
  // 1912 fits in available pay of 3000, so it deducts (percentage caps are no longer applied).
  const fits=ownLossRecoveryEstimate('da',3000,0,[line]);
  assert.equal(fits.lossRecoveryAmount,1912);
  assert.equal(fits.lossRecoveryDeferred,0);
  assert.equal(fits.netAmount,1088);

  // Whole line is deferred when it would wipe available pay.
  const deferred=ownLossRecoveryEstimate('da',1000,0,[line]);
  assert.equal(deferred.lossRecoveryAmount,0);
  assert.equal(deferred.lossRecoveryDeferred,1912);
  assert.equal(deferred.netAmount,1000);

  assert.equal(ownLossRecoveryEstimate('da',15729,100,[]).netAmount,15629);
});
