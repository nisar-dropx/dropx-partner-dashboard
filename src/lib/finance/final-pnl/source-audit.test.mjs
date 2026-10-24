import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileWorkforcePayroll} from './source-read.ts';
import {managerShares} from './manager-shares.ts';

const run={id:'r',status:'approved',period_start:'2026-09-01',period_end:'2026-09-30',calculated_at:'new'};
const publication={id:'pub',payroll_run_id:'r',workforce_id:'w',station_id:'a',period_start:run.period_start,period_end:run.period_end,source_calculated_at:'old',item:{gross_amount:100},deductions:[{code:'RECOVERY',amount:10}]};
const item={id:'item',payroll_run_id:'r',workforce_id:'w',station_id:'a',gross_amount:120};
test('approved current payroll replaces a stale review snapshot without carrying stale recovery proof',()=>{
 const result=reconcileWorkforcePayroll([publication],[run],[item]);
 assert.equal(result.publications.length,1);assert.equal(result.publications[0].id,'pub');assert.equal(result.publications[0].item.gross_amount,120);
 assert.equal(result.publications[0].payrollFinal,true);assert.deepEqual(result.publications[0].deductions,[]);assert.equal(result.reviewCount,0);
});
test('matching calculation revision retains published deduction evidence',()=>{
 const result=reconcileWorkforcePayroll([{...publication,source_calculated_at:'new'}],[run],[item]);assert.deepEqual(result.publications[0].deductions,publication.deductions);
});
test('cancelled publication never enters costs and review publications remain explicitly provisional',()=>{
 assert.equal(reconcileWorkforcePayroll([publication],[{...run,status:'cancelled'}],[]).publications.length,0);
 const review=reconcileWorkforcePayroll([publication],[{...run,status:'review'}],[]);assert.equal(review.reviewCount,1);assert.equal(review.publications[0].payrollFinal,false);assert.match(review.issues[0],/payroll accruals/);
});
test('legacy publications without payroll runs retain their known expense as an unverified accrual',()=>{
 const result=reconcileWorkforcePayroll([publication],[],[]);assert.equal(result.publications[0].item.gross_amount,100);assert.equal(result.publications[0].payrollFinal,false);assert.equal(result.publications[0].payrollUnverified,true);assert.deepEqual(result.publications[0].deductions,[]);assert.match(result.issues[0],/published amounts remain disclosed accruals/);
});
test('approved payroll with no publication still enters expense exactly once',()=>{
 const result=reconcileWorkforcePayroll([],[run],[item]);assert.equal(result.publications.length,1);assert.equal(result.publications[0].item.gross_amount,120);
 assert.throws(()=>reconcileWorkforcePayroll([publication],[run],[]),/exactly one/);
});
test('a final run replaces review for same person station period; duplicate final runs fail closed',()=>{
 const reviewRun={...run,id:'review',status:'review'};
 const result=reconcileWorkforcePayroll([{...publication,payroll_run_id:'review'}],[reviewRun,run],[item]);assert.equal(result.publications.length,1);assert.equal(result.reviewCount,0);
 assert.throws(()=>reconcileWorkforcePayroll([],[run,{...run,id:'second'}],[item,{...item,id:'other',payroll_run_id:'second'}]),/Multiple approved/);
});
test('current final station assignment wins and multiple station items are never duplicated',()=>{
 assert.equal(reconcileWorkforcePayroll([publication],[run],[{...item,station_id:'b'}]).publications[0].station_id,'b');
 const rows=reconcileWorkforcePayroll([publication,{...publication,id:'pub-b',station_id:'b'}],[run],[item,{...item,id:'item-b',station_id:'b',gross_amount:60}]).publications;
 assert.deepEqual(rows.map(row=>[row.station_id,row.item.gross_amount]),[['a',120],['b',60]]);
});

function managerFixture(){return {month:'2026-09',stations:[{id:'ho',station_code:'HO_KL',is_ho:true},{id:'a',station_code:'A',is_active:true},{id:'b',station_code:'B',is_active:false}],people:{employees:[{id:'p',profile_type:'employee',full_name:'Manager',employee_code:'M1',designation:'CLM',location_id:'ho',is_active:true}],assignments:['A','B'].map(station_code=>({employee_id:'p',station_code,kind:'managed',effective_from:'2026-01-01'})),salaries:[{id:'s',employee_id:'p',effective_from:'2026-01-01',monthly_ctc:30000}]},policies:[{designation_code:'CLM',designation_name:'Cluster Manager',mode:'managed',allocation:'equal',effective_from:'2026-01-01'}],rules:[],payroll:[]};}
test('inactive managed station cannot consume cost later discarded by P&L scope',()=>{
 const result=managerShares(managerFixture());assert.deepEqual(result.entries.map(entry=>[entry.station,entry.paise]),[['A',3000000]]);
});
test('published payroll awaiting verification replaces estimates but remains disclosed as accrued manager cost',()=>{
 const fixture=managerFixture();fixture.payroll=[{id:'legacy',personId:'p',profileType:'employee',from:'2026-09-01',to:'2026-09-30',paise:2400000,source:'Published payroll accrual',final:false}];
 const result=managerShares(fixture);assert.equal(result.entries[0].paise,2400000);assert.equal(result.accruedManagerCount,1);assert.match(result.entries[0].description,/Payroll accrual/);assert.doesNotMatch(result.entries[0].description,/Final payroll/);
});
test('explicit manager allocation excludes inactive and hidden recipients before denominator',()=>{
 const fixture=managerFixture();fixture.rules=[{employee_id:'p',station_codes:['A','B'],effective_from:'2026-01-01'}];
 assert.deepEqual(managerShares(fixture).entries.map(entry=>[entry.station,entry.paise]),[['A',3000000]]);
 fixture.stations[1].hide_from_location_list=true;const result=managerShares(fixture);assert.equal(result.entries.length,0);assert.match(result.issues[0],/no effective cost allocation/);
});
