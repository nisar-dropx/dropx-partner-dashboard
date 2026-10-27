import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryActionAllowed, mayActivateRedispute, departedPersonError, defaultLossFilter, hasFinalLossOutcome, lossStatusMatches } from './loss-recovery-controls.ts';
import { casePhase } from './nl-dispute-policy.ts';
test('only accountable recovery actions remain', () => {
  for (const code of ['post_dispute','da_left','utr_left','non_recoverable']) assert.equal(recoveryActionAllowed({code,allocation_required:false}),false);
  assert.equal(recoveryActionAllowed({code:'recover',allocation_required:true}),true);
  assert.equal(recoveryActionAllowed({code:'responsible_left',allocation_required:false}),true);
  assert.equal(recoveryActionAllowed({code:'post_dispute',allocation_required:true,dispute_fields_enabled:true}),false);
});
test('leadership activation excludes ground and cluster managers, including read-only leadership', () => {
  const auth={isMasterOwner:false,roleCode:null};
  for (const roleCode of ['OPERATIONS_CM','OPERATIONS_CLM','OPERATIONS_TL','OPERATIONS_AOM','OPERATIONS_BH','OPERATIONS_RH',null]) assert.equal(mayActivateRedispute({...auth,roleCode}),false);
  for (const roleCode of ['OPERATIONS_SLPM','OPERATIONS_NH','FINANCE_MANAGER','FINANCE_FINMGR','OPERATIONS_MANAGING_PARTNER','OPERATIONS_GM','GENERAL_MANAGER']) assert.equal(mayActivateRedispute({...auth,roleCode}),true,roleCode);
  assert.equal(mayActivateRedispute({...auth,isMasterOwner:true,readOnly:true}),false);
});
test('departed person needs identity and accountable follow-up', () => {
  assert.ok(departedPersonError({},'Person resigned'));
  assert.ok(departedPersonError({employee_id:'D123',employee_name:'Person'},'Person resigned'));
  assert.equal(departedPersonError({employee_id:'D123',employee_name:'Person',follow_up:'CM to collect balance by 30 October'},'Resigned on 20 October'),'');
});
test('cutoff uses India time at midnight on 25th', () => {
  assert.equal(defaultLossFilter(new Date('2026-10-24T18:29:59Z')),'');
  assert.equal(defaultLossFilter(new Date('2026-10-24T18:30:00Z')),'recoverable');
  assert.equal(defaultLossFilter(new Date('2026-10-31T18:30:00Z')),'');
});
test('only a confirmed source outcome moves a case to Final', () => {
  assert.equal(hasFinalLossOutcome(false,null),false);
  assert.equal(hasFinalLossOutcome(true,'Recoverable','pending','eDSP2'),false);
  assert.equal(casePhase({case_status:'pending',nl_status:'Recoverable',extra:{current_sla_stage:'eDSP2'}}).key,'respond');
  assert.equal(hasFinalLossOutcome(false,'Pending'),false);
  assert.equal(hasFinalLossOutcome(true,'Recoverable - Missed SLA by eDSP'),true);
  assert.equal(hasFinalLossOutcome(false,'Non-recoverable'),true);
  assert.equal(lossStatusMatches('recoverable',false,'missed'),false);
  assert.equal(lossStatusMatches('sla_missed',false,'missed'),true);
  assert.equal(casePhase({case_status:'sla_missed',nl_status:'Pending'}).key,'missed');
  assert.equal(casePhase({case_status:'sla_missed',nl_status:'Recoverable - Missed SLA by eDSP'}).key,'lost');
  assert.equal(casePhase({case_status:'not_disputed',nl_status:'Pending'}).key,'accepted');
  assert.equal(casePhase({case_status:'resolved',nl_status:''}).key,'amazon');
});

import { recoveryPending, recoveryNeedsReview } from './nl-loss-policy.ts';
test('legacy exceptions never look like completed recovery', () => {
  for (const code of ['post_dispute','non_recoverable','da_left','utr_left']) {
    const r={outcome_code:code,is_deleted:false,source_amount:100,source_status:'Recoverable'};
    assert.equal(recoveryPending(r),true);
    assert.equal(recoveryNeedsReview({recovery:r,amount:100,source_status:'Recoverable'}),true);
  }
  assert.equal(recoveryPending({outcome_code:'responsible_left',is_deleted:false}),true);
  assert.equal(recoveryPending({outcome_code:'already_recovered',is_deleted:false}),false);
});

import { groupRecoveryReview } from './nl-recovery-ledger-view.ts';
test('review groups split allocations without double-counting cases or draft deductions',()=>{
 const lines=[{month:'2026-09',case_key:'A',station_code:'S1',employee_ref:'1',full_name:'One',designation:'DA',total:60,deducted:10,in_payroll:20,outstanding:50,status:'scheduled'},
 {month:'2026-09',case_key:'A',station_code:'S1',employee_ref:'2',full_name:'Two',designation:'Manager',total:40,deducted:0,in_payroll:0,outstanding:40,status:'awaiting_approval'}];
 const [g]=groupRecoveryReview(lines,'station');
 assert.deepEqual([g.cases,g.people,g.assigned,g.deducted,g.draft,g.outstanding,g.pending],[1,2,100,10,20,90,40]);
 assert.equal(groupRecoveryReview(lines,'person').length,2);
 assert.equal(groupRecoveryReview(lines,'designation').length,2);
});
