const fs = require('fs'), path = require('path'), ts = require('typescript'), assert = require('node:assert/strict');
const cache = new Map();
function load(file) {
  file = path.resolve(file); if (!path.extname(file)) file += '.ts';
  if (cache.has(file)) return cache.get(file).exports;
  const m = {exports:{}}; cache.set(file,m);
  const js = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',js)(id=>id.startsWith('.')?load(path.join(path.dirname(file),id)):require(id),m,m.exports); return m.exports;
}
const {lossFacts,recoverableLossFacts,filterLossFacts,totalLossFacts,groupLossFacts} = load('src/lib/ops-pulse/loss-station-summary.ts');
const row=(id,amount,extra={})=>({case_key:id,report:'nl',month:'2026-09',station_code:'AAA',amount,source_status:'Recoverable',source_present:true,details:{case_status:'resolved'},recovery:null,...extra});
const plan=(amount,extra={})=>({source_amount:amount,source_status:'Recoverable',approval_status:'approved',allocations:[{amount}],updated_at:'2026-10-28T08:00:00Z',...extra});
const line=(id,employee,paid,extra={})=>({case_key:id,report:'nl',month:'2026-09',station_code:'AAA',employee_ref:employee,deducted:paid,waived:0,in_payroll:0,...extra});
const cases=[row('split',100,{recovery:plan(100)}),row('unassigned',70),row('initial',40,{details:{case_status:'pending',extra:{current_sla_stage:'NL1'}}}),row('saved',30,{source_status:'Non-Recoverable'}),row('slp',80,{report:'slp',station_code:'BBB',details:{in_initial:true,in_final:true}}),row('slp-open',50,{report:'slp',station_code:'BBB',details:{in_initial:true}}),row('removed',999,{source_present:false})];
const payroll=[line('split','a',20),line('split','b',30,{in_payroll:50}),line('split','a',20),line('unassigned','c',0,{waived:10})];
let facts=lossFacts([...cases,cases[0]],payroll,['Recoverable']);
assert.equal(facts.length,6,'one case per report/month/station identity');
assert.equal(facts.find(r=>r.key.endsWith('|split')).recovered,50,'sum employees once; ignore draft payroll');
assert.equal(facts.find(r=>r.key.endsWith('|unassigned')).remaining,60,'include unplanned recovery; subtract waiver');
assert.equal(facts.find(r=>r.key.endsWith('|initial')).remaining,0,'initial is not debt');
assert.equal(facts.find(r=>r.key.endsWith('|slp')).stage,'final','SLP initial+final is one final case');
assert.equal(facts.find(r=>r.key.endsWith('|slp-open')).waitingAmazon,true);
const summary = recoverableLossFacts(facts), summaryTotal = totalLossFacts(summary);
assert.equal(summary.length,3,'Summary includes only confirmed recoverable NL and SLP TIDs');
assert.equal(summaryTotal.amount,250,'Initial and non-recoverable values never enter Summary');
assert.equal(summaryTotal.recovered,50);assert.equal(summaryTotal.remaining,190);assert.equal(summaryTotal.waived,10);
assert.equal(summaryTotal.amount,summaryTotal.recovered+summaryTotal.remaining+summaryTotal.waived);
assert.equal(filterLossFacts(summary,{station:'BBB'}).length,1,'station filter excludes SLP Initial');
assert.equal(filterLossFacts(summary,{status:'pending_update'}).length,2);
assert.equal(filterLossFacts(summary,{status:'updated'}).length,1);
assert.equal(filterLossFacts(summary,{status:'all'}).length,3,'reset/all statuses cannot restore excluded cases');
const totals=totalLossFacts(facts);
assert.equal(totals.amount,370);assert.equal(totals.recovered,50);assert.equal(totals.remaining,190);assert.equal(totals.updated.count,1);assert.equal(totals.pending.count,2);assert.equal(totals.nonrecoverable.count,1);
assert.equal(filterLossFacts(facts,{station:'AAA',stage:'final',status:'pending_update'}).length,1);
assert.equal(filterLossFacts(facts,{station:'OUTSIDE'}).length,0);
assert.equal(filterLossFacts(facts,{period:'2025-01'}).length,0);
assert.deepEqual(groupLossFacts(facts,'station').map(r=>r.station),['AAA','BBB']);
assert.equal(groupLossFacts(facts,'remaining')[0].station,'AAA');
facts=lossFacts([row('receipt',100,{recovery:plan(100,{outcome_code:'already_recovered',recovery_details:{receipt_reference:'R',received_amount:'100'}})})],[line('receipt','a',40)],['Recoverable']);
assert.equal(facts[0].recovered,100,'receipt and payroll cannot double count the same loss');assert.equal(facts[0].remaining,0);
assert.equal(recoverableLossFacts(facts).length,1,'fully recovered cases remain visible');
facts=lossFacts([row('receipt',100,{recovery:plan(100,{approval_status:'proposed',outcome_code:'already_recovered',recovery_details:{receipt_reference:'R',received_amount:'100'}})})],[],['Recoverable']);
assert.equal(facts[0].recovered,0,'unapproved receipts are not money recovered');assert.equal(facts[0].remaining,100);
facts=lossFacts([row('precision',0.3)],[line('precision','a',0.1),line('precision','b',0.2)],['Recoverable']);assert.equal(facts[0].remaining,0);
facts=lossFacts([row('missing',100,{source_present:false,recovery:plan(100)}),row('won',100,{redispute:{workflow_status:'won'}})],[],['Recoverable']);assert.equal(facts.length,2);assert.equal(facts[0].remaining,100,'missing source with debt stays in summary');assert.equal(facts[1].remaining,0,'redispute win stops recovery without fabricating a collection');assert.equal(facts[1].recovered,0);assert.equal(recoverableLossFacts(facts).length,1,'redispute win excluded from recoverable Summary');
console.log('PASS loss summary: scoped filters, distinct TIDs, split allocations, draft payroll, receipts, waivers, unplanned debt, initial/final and penny rounding.');


assert.equal(lossFacts([row("period",1,{details:{period:"9",case_status:"resolved"}})],[],["Recoverable"])[0].period,"2026-09","NL uses its canonical month, not the raw source month number");
