import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source = readFileSync(new URL('./advance-register-payout-deductions.ts',import.meta.url),'utf8')
  .replace('"./supabase-pagination"',JSON.stringify(new URL('./supabase-pagination.ts',import.meta.url).href));
const {applyPayoutDeductionsToAdvanceRegister: reconcile} = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
function db(data,fail) { return {from(table) {
  const filters=[]; const query={select(){return this;},order(){return this;},
    eq(k,v){filters.push(r=>r[k]===v);return this;},in(k,v){filters.push(r=>v.includes(r[k]));return this;},
    range(a,b){return Promise.resolve(table===fail?{error:{message:'Read failed'}}:{data:(data[table]??[]).filter(r=>filters.every(f=>f(r))).slice(a,b+1),error:null});}
  };return query;
}};}
const scope = row => ({company_id:'company',...row});
const row = (id='advance',workerType='employee') => ({id,workerType,workforceId:'worker',total:2000,deducted:0,pending:2000,firstDuePeriod:'2026-10-01',linkStatus:'linked',status:'Pending',createdAt:'2026-10-01',recoveryHistory:[]});
const history = (amount,periodStart='2026-10-01') => ({id:'confirmed',amount,periodStart,status:'deducted'});
const noWorkforce = async()=>({rows:[],error:null});
const payroll = {
  hr_payroll_runs:[scope({id:'run',period_start:'2026-10-01',status:'calculated'})],
  hr_payroll_run_people:[scope({id:'person',run_id:'run',worker_type:'employee',worker_id:'worker'})],
  hr_payroll_run_items:[scope({id:'line',run_person_id:'person',code:'ADVANCE_RECOVERY',amount:2000,metadata:{advance_id:'advance'}})]
};
test('actual calculated HRMS item marks deducted; a reservation without a payout line does not',async()=>{
  const result=await reconcile(db(payroll),'company',[row(),row('missing')],noWorkforce);
  assert.deepEqual(result.map(r=>[r.id,r.deducted,r.pending,r.status]),[['advance',2000,0,'Fully deducted'],['missing',0,2000,'Pending']]);
  assert.equal(result[0].recoveryHistory[0].status,'deducted in payout');
});
test('company, worker identity and calculated run status must match the payout evidence',async()=>{
  for(const mutation of [
    data=>data.hr_payroll_runs[0].status='draft',
    data=>data.hr_payroll_run_people[0].worker_type='contractor',
    data=>data.hr_payroll_run_items[0].company_id='foreign',
    data=>data.hr_payroll_run_items[0].metadata.advance_id='unknown'
  ]) {const data=structuredClone(payroll);mutation(data);assert.equal((await reconcile(db(data),'company',[row()],noWorkforce))[0].deducted,0);}
});
test('the same HRMS recovery is not counted again when it becomes confirmed; separate months add',async()=>{
  let input={...row(),recoveryHistory:[history(2000)]};
  assert.equal((await reconcile(db(payroll),'company',[input],noWorkforce))[0].deducted,2000);
  input={...row(),total:4000,recoveryHistory:[history(1000,'2026-09-01')]};
  const result=(await reconcile(db(payroll),'company',[input],noWorkforce))[0];
  assert.equal(result.deducted,3000);assert.equal(result.pending,1000);
});
const payout=(amount,station='station',worker='worker')=>({id:station,locationId:station,reviewSubjectId:worker,reviewSubjectType:'workforce',deductionBreakdown:[{code:'ADVANCE_RECOVERY',recoveryKey:'ADVANCE:advance',amount}]});
test('Workforce live worksheet split across stations counts exact advance lines and preserves partial balances',async()=>{
  const load=async(from,to,ids)=>{assert.equal(from,'2026-10-01');assert.equal(to,'2026-10-31');assert.deepEqual(ids,['worker']);return {rows:[payout(400),payout(600,'second'),payout(999,'foreign','someone-else')],error:null};};
  const result=(await reconcile(db({}),'company',[row('advance','workforce')],load))[0];
  assert.equal(result.deducted,1000);assert.equal(result.pending,1000);assert.equal(result.status,'Partially deducted');
});
test('latest publication supersedes old revisions and is not added again to the live worksheet',async()=>{
  const publication=(revision,amount)=>scope({id:String(revision),workforce_id:'worker',station_id:'station',period_start:'2026-10-01',period_end:'2026-10-31',publication_kind:'worksheet',revision,snapshot:{worksheet:{deduction_breakdown:[{code:'ADVANCE_RECOVERY',recoveryKey:'ADVANCE:advance',amount}]}}});
  const result=(await reconcile(db({workforce_payout_publications:[publication(2,1200),publication(1,700)]}),'company',[row('advance','workforce')],async()=>({rows:[payout(1200)],error:null})))[0];
  assert.equal(result.deducted,1200);assert.equal(result.pending,800);
});
test('confirmed Workforce principal plus the remaining live due amount counts once and caps at principal',async()=>{
  const input={...row('advance','workforce'),deducted:500,pending:1500,recoveryHistory:[history(500)]};
  const result=(await reconcile(db({}),'company',[input],async()=>({rows:[payout(1500)],error:null})))[0];
  assert.equal(result.deducted,2000);assert.equal(result.pending,0);
  const repeated=(await reconcile(db({}),'company',[result],noWorkforce))[0];
  // With no current payout line the display reverts to confirmed recovery only.
  assert.equal(repeated.deducted,500);
});
test('missing workers stay pending and payout verification failures cannot display invented balances',async()=>{
  const input={...row('advance','workforce'),workforceId:'',linkStatus:'pending'};
  assert.equal((await reconcile(db({}),'company',[input],noWorkforce))[0].pending,2000);
  await assert.rejects(reconcile(db(payroll,'hr_payroll_run_items'),'company',[row()],noWorkforce),/Read failed/);
  await assert.rejects(reconcile(db({}),'company',[row('advance','workforce')],async()=>({rows:[],error:'Payout unavailable'})),/Payout unavailable/);
});
