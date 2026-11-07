import test from 'node:test';
import assert from 'node:assert/strict';
import {pnlDisplayEntries,pnlDisplayEntry,currentRevenue,currentDirectExpenses,allocatedCorporate,stationAlerts} from './presentation.ts';
import {money} from './model.ts';
import {entryTotals,statementGroups} from './analysis.ts';
import {buildStationSummary} from './station-summary.ts';
const e=(id,side,paise,extra={})=>({id,side,paise,station:'BASE',sourceStation:'XPT',month:'2026-10',head:'Source',description:'',source:'Recorded',reference:id,date:'2026-10-31',...extra});
test('loss debit is negative revenue, confirmed recovery is negative expense, and net and source records do not change',()=>{
 const entries=[e('sales','income',100000),e('cost','expense',70000),e('loss','expense',12000,{head:'Loss chargeback',description:'COD loss',details:[{date:'2026-10-31',reference:'INV',label:'COD',paise:12000}]}),e('recovery','income',5000,{head:'Loss recovery',recovery:true,details:[{date:'2026-10-31',reference:'PAY',label:'Deduction',paise:5000}]})];
 const original=JSON.stringify(entries),shown=pnlDisplayEntries(entries);
 assert.deepEqual(shown.map(r=>[r.id,r.side,r.paise]),[['sales','income',100000],['cost','expense',70000],['loss','income',-12000],['recovery','expense',-5000]]);
 assert.equal(shown[2].head,'Loss incurred');assert.equal(shown[2].details[0].paise,-12000);assert.equal(shown[3].details[0].paise,-5000);
 assert.equal(entryTotals(shown).income,88000);assert.equal(entryTotals(shown).expense,65000);assert.equal(entryTotals(shown).profit,23000);assert.equal(entryTotals(entries).profit,23000);
 assert.equal(JSON.stringify(entries),original);assert.deepEqual(pnlDisplayEntries(shown),shown,'presentation is idempotent');
 assert.equal(shown[2].id,entries[2].id,'editing still identifies the original source');
});
test('reversals and saved corrections keep their signs and detailed differences',()=>{
 const loss=e('loss','expense',-3000,{head:'Loss chargeback',modified:true,details:[{date:'2026-10-31',reference:'INV',label:'Original credit',paise:-2000}]}),recovery=e('rec','income',-1000,{recovery:true});
 const shown=pnlDisplayEntries([loss,recovery]);assert.equal(shown[0].paise,3000);assert.equal(shown[0].details[0].paise,2000);assert.equal(shown[1].paise,1000);assert.equal(entryTotals(shown).profit,2000);
});
test('current station totals agree with the two-sided presentation even when HO or revenue is missing',()=>{
 const report={month:'2026-10',stations:['BASE','MISSING'],dimensions:[{code:'BASE',name:'Base',model:'EDSP',isHo:false},{code:'MISSING',name:'Missing',model:'EDSP',isHo:false}],entries:[e('sales','income',100000),e('cost','expense',70000),e('loss','expense',12000,{head:'Loss chargeback'}),e('rec','income',5000,{recovery:true}),e('missing','expense',4000,{station:'MISSING'})],overheadPools:[{code:'HO',mode:'corporate',rule:{recipient_models:['EDSP']},unallocated:10000,income:0,corporateShares:[],allocations:[],issue:'Other model invoice revenue is missing.'}]};
 const rows=buildStationSummary(report).rows,base=rows.find(r=>r.station==='BASE'),missing=rows.find(r=>r.station==='MISSING');
 assert.equal(base.net,23000);assert.equal(base.complete,false);assert.equal(allocatedCorporate(base),0);assert.equal(currentRevenue(base)-currentDirectExpenses(base)-base.regionalHo-allocatedCorporate(base),23000);
 assert.equal(entryTotals(pnlDisplayEntries(base.entries)).profit,base.net);assert.equal(missing.net,-4000);assert.match(stationAlerts(missing).join(' '),/Revenue is not recorded for MISSING/);
 assert.match(stationAlerts(base).join(' '),/Other model invoice revenue is missing/);
});
test('deleted records are excluded and ordinary credits retain their source meaning',()=>{
 const records=[e('credit','expense',-1500,{head:'Fuel'}),e('deleted','expense',3000,{head:'Loss chargeback',deleted:true})];
 assert.equal(pnlDisplayEntry(records[0]),records[0]);assert.equal(entryTotals(pnlDisplayEntries(records)).profit,1500);
 assert.equal(statementGroups(pnlDisplayEntries(records)).length,1);
});

test('zero deductions display as zero rather than negative zero',()=>{assert.equal(money(-0),money(0));assert.match(money(-100),/-/);});
