import test from 'node:test';
import assert from 'node:assert/strict';
import {nlRecoveryEvidence,lossCategory} from './nl-recovery.ts';
const loss={month:'2026-09',case_key:'CASE1',station_code:'KGQA',amount:500,report:'nl'};
const key='2026-09|CASE1|workforce:w1';
const pub={id:'pub',workforce_id:'w1',period_start:'2026-10-01',period_end:'2026-10-31',deductions:[{code:'LOSS_RECOVERY',amount:100,recoveryKey:key}]};
const run={id:'run',period_start:'2026-10-01',period_end:'2026-10-31',status:'calculated'};
const person={id:'person',run_id:'run'};
const item={id:'line',run_person_id:'person',code:'OPS_LOSS_RECOVERY',amount:50,metadata:{recovery_key:'2026-09|CASE1|employee:e1'}};
const build=(raw=[pub],final=[{...pub,payrollFinal:false,deductions:[]}],runs=[],people=[],items=[])=>nlRecoveryEvidence('2026-10',[loss],raw,final,runs,people,items);
test('unverified Workforce and calculated People deductions stay pending rather than recovery income',()=>{
 const r=build([pub],[{...pub,payrollFinal:false,deductions:[]}],[run],[person],[item]);
 assert.equal(r.entries.length,0);assert.equal(r.pendingByCase.get('nl:2026-09:CASE1'),15000);assert.equal(r.pendingThisMonthByCase.get('nl:2026-09:CASE1'),15000);
});
test('approved current payroll recognizes the explicit deduction in salary month at incident station',()=>{
 const r=build([pub],[{...pub,payrollFinal:true}]);assert.equal(r.entries[0].paise,10000);assert.equal(r.entries[0].station,'KGQA');assert.equal(r.entries[0].month,'2026-10');assert.equal(r.entries[0].caseKey,'nl:2026-09:CASE1');assert.equal(r.postedByCase.get('nl:2026-09:CASE1'),10000);
});
test('stale approved snapshots, unrelated generic deductions and unknown case keys cannot manufacture recovery',()=>{
 const other={...pub,id:'other',deductions:[{code:'RECOVERY',amount:200,recoveryKey:key},{code:'LOSS_RECOVERY',amount:500,recoveryKey:'unknown'}]};
 const r=build([pub,other],[{...pub,payrollFinal:true,deductions:[]},other]);assert.equal(r.entries.length,0);assert.equal(r.pendingByCase.get('nl:2026-09:CASE1'),10000);
});
test('final People proof overrides same-key draft and uses actual payroll amount',()=>{
 const r=build([],[],[run,{...run,id:'approved',status:'approved'}],[person,{id:'p2',run_id:'approved'}],[item,{...item,id:'confirmed',run_person_id:'p2',amount:40}]);assert.equal(r.entries.length,1);assert.equal(r.entries[0].paise,4000);assert.equal(r.pendingByCase.size,0);
});
test('prior payroll counts recovered to date, future payroll is excluded from an earlier report',()=>{
 const old={...pub,id:'old',period_start:'2026-09-01',period_end:'2026-09-30'},future={...pub,id:'future',period_start:'2026-11-01'};
 const r=build([old,future],[{...old,payrollFinal:true},{...future,payrollFinal:true}]);assert.equal(r.entries.length,0);assert.equal(r.postedByCase.get('nl:2026-09:CASE1'),10000);
});
test('conflicting confirmed salary months fail closed and installments remain distinct',()=>{
 const next={...pub,id:'next',period_start:'2026-09-01'};assert.throws(()=>build([pub,next],[{...pub,payrollFinal:true},{...next,payrollFinal:true}]),/Conflicting/);
 const installments={...pub,deductions:[{code:'LOSS_RECOVERY',amount:25,recoveryKey:key+'|1'},{code:'LOSS_RECOVERY',amount:25,recoveryKey:key+'|2'}]};assert.equal(build([installments],[{...installments,payrollFinal:true}]).entries.length,2);
});
test('loss types distinguish package and cash shortages',()=>{assert.equal(lossCategory('slp',{}),'Package loss (SLP)');assert.equal(lossCategory('nl',{category:'COD shortage'}),'COD loss');});
test('pipe-containing case identifiers resolve exactly without a shorter-case prefix overjoin',()=>{
 const composite={...loss,case_key:'CASE1|legacy|event|2'};
 const recoveryKey=`2026-09|${composite.case_key}|workforce:w1|2`;
 const raw={...pub,deductions:[{code:'LOSS_RECOVERY',amount:66,recoveryKey}]};
 const r=nlRecoveryEvidence('2026-10',[loss,composite],[raw],[{...raw,payrollFinal:true}],[],[],[]);
 assert.equal(r.entries.length,1);assert.equal(r.entries[0].caseKey,'nl:2026-09:CASE1|legacy|event|2');
 assert.equal(r.postedByCase.get('nl:2026-09:CASE1|legacy|event|2'),6600);assert.equal(r.postedByCase.has('nl:2026-09:CASE1'),false);
 const unknown={...raw,deductions:[{code:'LOSS_RECOVERY',amount:66,recoveryKey:'2026-09|CASE1|unregistered|workforce:w1'}]};
 assert.equal(nlRecoveryEvidence('2026-10',[loss],[unknown],[{...unknown,payrollFinal:true}],[],[],[]).entries.length,0);
});
