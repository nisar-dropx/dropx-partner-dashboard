import test from 'node:test';
import assert from 'node:assert/strict';
import {stationLossEntries,finalRecoverableLoss,lossRecognitionMonth,validateLossPeriod} from './loss-recognition.ts';
import {nlRecoveryEvidence,nlReceiptEvidence} from './nl-recovery.ts';
const accepted=['Recoverable','Recoverable - Missed SLA by eDSP2'];
const row={month:'2026-09',case_key:'C1',station_code:'XPT',report:'nl',source_status:'Recoverable',source_present:true,amount:100,details:{case_status:'resolved'}};
test('final station loss belongs to next billing month, retains original station and exact case',()=>{
 assert.equal(stationLossEntries('2026-09',[row],accepted).length,0);
 const [e]=stationLossEntries('2026-10',[row],accepted);assert.equal(e.paise,10000);assert.equal(e.station,'XPT');assert.equal(e.sourceStation,'XPT');assert.equal(e.caseKey,'nl:2026-09:C1');
 assert.equal(lossRecognitionMonth({...row,month:'2026-12'}),'2027-01');
});
test('pending NL, nonrecoverable, removed and won redispute never enter loss debits',()=>{
 for(const c of [{...row,source_status:'Non-Recoverable'},{...row,source_present:false},{...row,redispute:{workflow_status:'won'}},{...row,details:{case_status:'pending',extra:{current_sla_stage:'eDSP2'}}}])assert.equal(finalRecoverableLoss(c,accepted),false);
 assert.equal(finalRecoverableLoss({...row,source_status:'Recoverable - Missed SLA by eDSP2',details:{case_status:'sla_missed',extra:{current_sla_stage:'eDSP2'}}},accepted),true);
});
test('SLP Initial excluded even if approved; only final source is charged once',()=>{
 const initial={...row,report:'slp',source_status:'SLP Initial',details:{period:'Aug-Sep',in_final:false}};
 const final={...initial,case_key:'F1',source_status:'SLP Final',details:{...initial.details,in_final:true}};
 assert.equal(stationLossEntries('2026-10',[initial,final],accepted).length,1);
 assert.throws(()=>stationLossEntries('2026-10',[final,final],accepted),/Duplicate/);
});
test('master period overrides billing month without station hardcoding',()=>{
 const rule=validateLossPeriod({report:'slp',period:'Aug-Sep',pnl_month:'2026-11',source:'Confirmed invoice period'});
 const slp={...row,report:'slp',details:{period:'Aug-Sep',in_final:true}};
 assert.equal(stationLossEntries('2026-10',[slp],accepted,[rule]).length,0);
 assert.equal(stationLossEntries('2026-11',[slp],accepted,[rule]).length,1);
 assert.throws(()=>lossRecognitionMonth(slp,[rule,rule]),/Conflicting/);
 assert.throws(()=>validateLossPeriod({...rule,pnl_month:'2026-13'}));
});
const evidence=()=>nlRecoveryEvidence('2026-10',[row],[],[],[],[],[]);
const receipt={month:row.month,case_key:row.case_key,outcome_code:'already_recovered',approval_status:'approved',source_amount:100,source_status:row.source_status,recovery_details:{received_amount:100,received_date:'2026-10-03',receipt_reference:'RCPT-1'}};
test('only approved, dated full receipt contributes recovery',()=>{
 const out=nlReceiptEvidence('2026-10',[row],[receipt],evidence());assert.equal(out.entries[0].paise,10000);assert.equal(out.postedByCase.get('nl:2026-09:C1'),10000);
 for(const p of [{...receipt,approval_status:'proposed'},{...receipt,is_deleted:true},{...receipt,source_amount:90},{...receipt,recovery_details:{...receipt.recovery_details,received_date:'2026-11-01'}},{...receipt,recovery_details:{...receipt.recovery_details,receipt_reference:''}}])assert.equal(nlReceiptEvidence('2026-10',[row],[p],evidence()).entries.length,0);
});
test('receipt/payroll overlap counted once in current and future months',()=>{
 const base=evidence();base.postedByCase.set('nl:2026-09:C1',4000);base.entries=[{id:'pay',month:'2026-10',station:'XPT',sourceStation:'XPT',side:'income',head:'Loss recovery',description:'Payroll',paise:4000,source:'Payroll',reference:'P1',date:'2026-10-31',recovery:true,caseKey:'nl:2026-09:C1'}];
 const out=nlReceiptEvidence('2026-10',[row],[receipt],base);assert.equal(out.entries.reduce((n,e)=>n+e.paise,0),10000);
 const later={...base,entries:base.entries.map(e=>({...e,month:'2026-11'}))};
 assert.equal(nlReceiptEvidence('2026-11',[row],[receipt],later).entries.length,0);
 assert.equal(nlReceiptEvidence('2026-11',[row],[receipt],later).postedByCase.get('nl:2026-09:C1'),10000);
});
