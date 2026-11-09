import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {fitWorkforceAdvances} from './workforce-paid-advances-allocation.ts';

function load(publications, payments = []) {
  const source = readFileSync(new URL('./workforce-paid-advances.ts', import.meta.url), 'utf8');
  const module = {exports:{}};
  const queries = [];
  const due = [{advance_id:'old', worker_id:'w', amount:500, paid_at:'2026-10-01'}];
  function builder(table) {
    const query = {table};
    for (const method of ['select','eq','in','order']) query[method] = (...args) => {
      queries.push({table,method,args}); return query;
    };
    return query;
  }
  const dependencies = {
    'server-only': {},
    '@/lib/supabase-admin': {supabaseAdmin:{rpc:()=>builder('due'),from:builder}},
    '@/lib/supabase-pagination': {readAllRows:async q=>({data:q.table==='due'?due:q.table==='workforce_payout_publications'?publications:payments,error:null})},
    './workforce-paid-advances-allocation': {fitWorkforceAdvances}
  };
  new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{
    assert.ok(name in dependencies,name);return dependencies[name];
  },module.exports);
  return {apply:module.exports.applyWorkforcePaidAdvances,queries};
}
const row = () => ({id:'s',locationId:'s',reviewSubjectId:'w',reviewSubjectType:'workforce',netAmount:1000,deductions:0,deductionBreakdown:[]});
const line = amount => ({code:'ADVANCE_RECOVERY',recoveryKey:'ADVANCE:old',amount});

test('compact publication projection preserves latest revision allocation and paid salary',async()=>{
  const {apply,queries}=load([
    {workforce_id:'w',station_id:'s',revision:2,deduction_breakdown:[line(200)]},
    {workforce_id:'w',station_id:'s',revision:1,deduction_breakdown:[line(500)]}
  ],[{workforce_id:'w',status:'paid',instruction_amount:800}]);
  const result=await apply('company','2026-10-01','2026-10-31',[row()]);
  assert.equal(result[0].netAmount,800);
  assert.equal(result[0].deductionBreakdown[0].amount,200);
  assert.ok(queries.some(q=>q.method==='select'&&q.args[0]==='id,workforce_id,station_id,revision,deduction_breakdown:snapshot->worksheet->deduction_breakdown'));
  for (const table of ['workforce_payout_publications','workforce_payout_payment_items']) {
    assert.ok(queries.some(q=>q.table===table&&q.method==='eq'&&q.args[0]==='company_id'&&q.args[1]==='company'));
    assert.ok(queries.some(q=>q.table===table&&q.method==='eq'&&q.args[0]==='period_start'&&q.args[1]==='2026-10-01'));
  }
});

test('empty latest breakdown never revives an obsolete prior allocation',async()=>{
  const {apply}=load([
    {workforce_id:'w',station_id:'s',revision:2,deduction_breakdown:null},
    {workforce_id:'w',station_id:'s',revision:1,deduction_breakdown:[line(200)]}
  ]);
  const result=await apply('company','2026-10-01','2026-10-31',[row()]);
  assert.equal(result[0].deductionBreakdown[0].amount,500);
  assert.equal(result[0].netAmount,500);
});
