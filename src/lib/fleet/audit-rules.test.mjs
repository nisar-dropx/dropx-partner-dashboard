import test from 'node:test';import assert from 'node:assert/strict';
import {auditPresets,normalizeAuditConfig,evaluateAuditResponse,auditApplies,auditDueDate} from './audit-rules.ts';
import {fleetAttention} from './attention.ts';
test('poor tyre needs a remark and a valid planned deadline',()=>{
 const c=auditPresets.condition;
 assert.throws(()=>evaluateAuditResponse(c,'poor','',7,'2026-10-05'),/remark/);
 assert.throws(()=>evaluateAuditResponse(c,'poor','Sidewall wear',0,'2026-10-05'),/days/);
 const r=evaluateAuditResponse(c,'poor','Sidewall wear',7,'2026-10-05');assert.equal(r.passed,false);assert.equal(r.due,'2026-10-12');assert.equal(r.option.photos,1);
});
test('immediate replacement is due today; caller cannot invent an answer',()=>{
 const r=evaluateAuditResponse(auditPresets.condition,'needs_immediate_replacement','Damaged sidewall',30,'2026-10-05');assert.equal(r.due,'2026-10-05');assert.equal(r.option.severity,'critical');assert.throws(()=>evaluateAuditResponse(auditPresets.condition,'everything_fine','',7,'2026-10-05'),/configured/);
});
test('configurable option evidence and dates survive normalization',()=>{
 const c=normalizeAuditConfig({...auditPresets.condition,options:auditPresets.condition.options.map(o=>({...o,photos:2}))});assert.equal(evaluateAuditResponse(c,'good','',7,'2026-10-05').option.photos,2);assert.equal(auditDueDate('2026-10-30',7),'2026-11-06');assert.throws(()=>normalizeAuditConfig({...c,options:[c.options[0],c.options[0]]}),/unique/);
});
test('fuel applicability excludes combustion-only controls from EV',()=>{assert.equal(auditApplies({...auditPresets.condition,fuels:['Diesel','Petrol','CNG']},'EV'),false);assert.equal(auditApplies({...auditPresets.condition,fuels:['EV']},'ev'),true);});
test('attention includes future replacements, keeps resolved history, respects module visibility',()=>{
 const data={today:'2026-10-05',vehicles:[{id:'v',ownershipType:'own',status:'active'}],documents:[],documentTypes:[],audits:[],payments:[],settings:{},capabilities:{visibleSections:['audits']},findings:[{id:'1',vehicleId:'v',auditId:'a',vehicleNo:'KL1',stationCode:'KOZA',finding:'Tyre',severity:'high',actionRequired:'Replace',dueDate:'2026-10-12',status:'open'},{id:'2',vehicleId:'v',auditId:'a',vehicleNo:'KL1',stationCode:'KOZA',finding:'Mirror',severity:'critical',actionRequired:'Fix',dueDate:'2026-10-05',status:'resolved'}]};
 const rows=fleetAttention(data);assert.equal(rows.length,2);assert.equal(rows[0].findingId,'1');assert.equal(rows[0].due,'2026-10-12');assert.equal(rows[1].resolved,true);assert.equal(fleetAttention({...data,capabilities:{visibleSections:[]}}).length,0);
});
