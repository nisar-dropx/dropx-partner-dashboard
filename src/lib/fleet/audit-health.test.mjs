import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeHealth,compareFindings} from './audit-health.ts';
import {normalizeAuditConfig,auditPresets,scoreAuditAnswer} from './audit-rules.ts';
test('weighted health excludes unassessed and zero-weight items and flags critical independently',()=>{
 const result=summarizeHealth([{category:'Brakes',weight:4,score:0,critical:true},{category:'Body',weight:1,score:100},{category:'Test',weight:4,score:null},{category:'Note',weight:0,score:100}]);
 assert.equal(result.score,20);assert.equal(result.critical,true);assert.equal(result.excluded,2);assert.equal(result.areas[0].share,80);
 assert.equal(summarizeHealth([{category:'None',weight:2,score:null}]).score,null);
});
test('master weights and answer points are normalized then captured in immutable snapshots',()=>{
 const c=normalizeAuditConfig({...auditPresets.condition,weight:4});
 const snapshot=scoreAuditAnswer(c,'average',true,'critical');assert.equal(snapshot.score,75);assert.equal(snapshot.weight,4);
 assert.equal(scoreAuditAnswer(c,'unable_to_inspect',false,'high').score,null);
 assert.equal(scoreAuditAnswer(c,'needs_immediate_replacement',false,'high').critical,true);
 c.weight=1;assert.equal(snapshot.weight,4);
 const custom=normalizeAuditConfig({...c,options:c.options.map(o=>({...o,score:50}))});assert.equal(scoreAuditAnswer(custom,'good',true,'high').score,50);
});
const finding=(patch={})=>({id:'old',auditId:'a',itemId:'tyre',category:'Tyres',finding:'Tyre: Poor',severity:'high',action:'Replace',due:'2026-10-07',status:'open',resolvedAt:null,resolution:'',date:'2026-10-01',...patch});
const response=(passed)=>({itemId:'tyre',category:'Tyres',label:'Tyre',passed,weight:3,score:passed?100:25});
test('repeat gaps, recurrence after repair and passing without closure remain distinct',()=>{
 assert.equal(compareFindings([finding()],[response(false)],'2026-10-06')[0].comparison,'Repeated');
 assert.equal(compareFindings([finding({status:'resolved',resolvedAt:'2026-10-04'})],[response(false)],'2026-10-06')[0].comparison,'Recurred');
 assert.equal(compareFindings([finding()],[response(true)],'2026-10-06')[0].comparison,'Pass recorded · closure pending');
 assert.equal(compareFindings([finding()],[],'2026-10-06')[0].comparison,'Not reassessed');
 assert.equal(compareFindings([finding({status:'resolved',resolvedAt:'2026-10-08'})],[response(false)],'2026-10-06')[0].comparison,'Repeated');
});
test('recurrence compares checklist IDs and never assumes every defect in same category is identical',()=>{
 assert.equal(compareFindings([finding({itemId:'mirror'})],[response(false)],'2026-10-06')[0].comparison,'Not reassessed');
 const rows=compareFindings([finding(),finding({id:'earlier',date:'2026-09-01'})],[response(false)],'2026-10-06');assert.equal(rows.length,1);assert.equal(rows[0].previousCount,2);
});
