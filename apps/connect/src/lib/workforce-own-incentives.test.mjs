import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ownIncentives} from './workforce-own-incentives.ts';
export {ownIncentives};
const campaign=(extra={})=>({id:'campaign',company_id:'company',name:'Approved production reward',provider_id:null,station_id:null,designation_id:null,metric:'total_delivery',calculation_type:'per_unit_above_threshold',threshold_value:45,rate_value:12,flat_amount:0,maximum_amount:null,effective_from:'2026-09-01',effective_to:'2026-09-30',status:'active',approved_at:'2026-08-31T00:00:00Z',...extra});
const row=(extra={})=>({id:'a',work_date:'2026-09-01',provider_id:'provider',station_id:'station',total_delivery:10,total_activity:10,amazon_delivery:10,swa_delivery:0,c_return:0,mfn:0,...extra});
const calculate=(sources,campaigns=[campaign()],extra={})=>ownIncentives({companyId:'company',canonical:true,designationId:'da',from:'2026-09-01',to:'2026-09-30',sources,campaigns,...extra});
test('daily threshold combines own IDs without counting twice; different days stay separate',()=>{
 const result=calculate([row(),row({id:'b',total_delivery:50,total_activity:50}),row({id:'c',work_date:'2026-09-02',total_delivery:10})]);
 assert.equal(result.summary.amount,180);assert.deepEqual([...result.bySource.values()],[30,150,0]);assert.equal(result.summary.campaigns[0].workDays,1);
});
test('daily flat reward and cap apply once across IDs',()=>{
 const rows=[row({total_delivery:50,total_activity:50}),row({id:'b',total_delivery:50,total_activity:50})];
 assert.equal(calculate(rows,[campaign({calculation_type:'flat_threshold',flat_amount:100})]).summary.amount,100);
 assert.equal(calculate(rows,[campaign({maximum_amount:99.99})]).summary.amount,99.99);
 assert.equal(calculate(rows,[campaign({maximum_amount:0})]).summary.amount,0);
});
test('cent allocation is deterministic, exact and independent of source order',()=>{
 const rows=[row({id:'c',total_activity:1}),row({id:'b',total_activity:1}),row({total_activity:1})],policy=campaign({calculation_type:'flat_threshold',threshold_value:0,flat_amount:1});
 const a=calculate(rows,[policy]),b=calculate([...rows].reverse(),[policy]);
 assert.equal(a.summary.amount,1);assert.deepEqual([...a.bySource].sort(),[...b.bySource].sort());assert.deepEqual([...a.bySource].sort(),[['a',.33],['b',.33],['c',.34]]);
});
test('provider, station, designation and effective dates constrain eligible work',()=>{
 const rows=[row({total_delivery:100,total_activity:100})];
 for(const change of [{provider_id:'other'},{station_id:'other'},{designation_id:'other'},{effective_from:'2026-09-02'},{effective_to:'2026-08-31',effective_from:'2026-08-01'}])assert.equal(calculate(rows,[campaign(change)]).summary.amount,0);
 assert.equal(calculate(rows,[campaign({provider_id:'provider',station_id:'station',designation_id:'da'})]).summary.amount,660);
});
test('draft/unapproved retired campaigns and missing canonical identity do not earn',()=>{
 const rows=[row({total_delivery:100})];
 for(const status of ['draft','rejected','cancelled'])assert.equal(calculate(rows,[campaign({status})]).summary.amount,0);
 assert.equal(calculate(rows,[campaign({status:'closed',approved_at:null})]).summary.amount,0);
 assert.equal(calculate(rows,[campaign({status:'closed'})]).summary.amount,660);
 assert.equal(calculate(rows,[campaign()],{canonical:false}).summary.amount,0);
});
test('all supported metrics use the selected production count',()=>{
 for(const metric of ['total_delivery','total_activity','amazon_delivery','swa_delivery','c_return','mfn'])assert.equal(calculate([row({[metric]:50})],[campaign({metric})]).summary.amount,60);
});
test('company mismatch, duplicates, invalid dates/counts/policies fail closed',()=>{
 assert.throws(()=>calculate([row()],[campaign({company_id:'other'})]),/scope/);
 assert.throws(()=>calculate([row(),row()]),/Duplicate/);
 assert.throws(()=>calculate([row()],[campaign(),campaign()]),/identity/);
 for(const change of [{id:''},{work_date:'2026-09-31'},{work_date:'2026-08-31'},{total_delivery:-1},{total_activity:1.5},{mfn:Infinity}])assert.throws(()=>calculate([row(change)]));
 for(const change of [{metric:'unknown'},{calculation_type:'unknown'},{rate_value:-1},{maximum_amount:NaN},{effective_to:'2026-09-31'}])assert.throws(()=>calculate([row()],[campaign(change)]));
});
test('multiple campaigns add without leaking policy scope or internal comments',()=>{
 const result=calculate([row({total_delivery:50})],[campaign({owner_note:'PRIVATE',created_by:'PRIVATE'}),campaign({id:'b',rate_value:1})]);
 assert.equal(result.summary.amount,65);assert.equal(result.bySource.get('a'),65);
 assert.deepEqual(Object.keys(result.summary.campaigns[0]).sort(),['amount','cycles','id','name','workDays']);assert.equal(JSON.stringify(result.summary).includes('PRIVATE'),false);
});
test('empty results are genuinely zero and excessive values fail',()=>{
 assert.deepEqual(calculate([]).summary,{amount:0,campaigns:[]});
 assert.throws(()=>calculate([row({total_delivery:100})],[campaign({rate_value:Number.MAX_SAFE_INTEGER})]),/range/);
});
test('attendance reporting bonus is visible with biometric day and late-day progress',()=>{
 const policy=campaign({
  name:'Monthly attendance bonus',provider_id:'provider',station_id:'station',location_model_id:null,
  incentive_type:'attendance',cycle_type:'monthly',metric:'attendance_compliance',calculation_type:'flat_threshold',
  threshold_value:0,rate_value:0,flat_amount:500,minimum_activity:0,reporting_time:'07:30:00',minimum_present_days:2,allowed_late_days:1,tiers:[]
 });
 const attendance=[
  {id:'p1',work_date:'2026-09-01',provider_id:'provider',location_model_id:null,station_id:'station',in_time:'2026-09-01T01:45:00Z'},
  {id:'p2',work_date:'2026-09-02',provider_id:'provider',location_model_id:null,station_id:'station',in_time:'2026-09-02T02:15:00Z'}
 ];
 const result=calculate([],[policy],{attendance});
 assert.equal(result.summary.amount,500);
 assert.deepEqual({present:result.summary.campaigns[0].cycles[0].presentDays,late:result.summary.campaigns[0].cycles[0].lateDays},{present:2,late:1});
});
test('associate incentive display is compact and keeps the useful breakdown',()=>{
 const source=readFileSync(new URL('../components/connect-pay-incentives.tsx',import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,module={exports:{}},require=createRequire(import.meta.url);
 new Function('require','exports',output)(name=>name.endsWith('.module.css')?{card:'card',note:'note'}:require(name),module.exports);
 const render=value=>renderToStaticMarkup(createElement(module.exports.ConnectPayIncentives,{incentives:value}));
 const html=render(calculate([row({total_delivery:50})]).summary);
 for(const text of ['Incentives','View calculation','₹60','1 Sep 2026'])assert.ok(html.includes(text),text);
 for(const repeatedHelp of ['Daily thresholds and caps','not payment confirmation'])assert.ok(!html.includes(repeatedHelp),repeatedHelp);
 assert.match(render(calculate([]).summary),/No eligible incentive plan/);
 const attendanceSummary=calculate([],[campaign({name:'Monthly attendance bonus',provider_id:'provider',station_id:'station',incentive_type:'attendance',cycle_type:'monthly',metric:'attendance_compliance',calculation_type:'flat_threshold',threshold_value:0,rate_value:0,flat_amount:500,minimum_activity:0,reporting_time:'07:30:00',minimum_present_days:1,allowed_late_days:0,tiers:[]})],{attendance:[{id:'p1',work_date:'2026-09-01',provider_id:'provider',location_model_id:null,station_id:'station',in_time:'2026-09-01T01:45:00Z'}]}).summary;
 const attendanceHtml=render(attendanceSummary);
 for(const text of ['Monthly attendance bonus','1/1 reporting days','0/0 late','07:30 IST'])assert.ok(attendanceHtml.includes(text),text);
});
