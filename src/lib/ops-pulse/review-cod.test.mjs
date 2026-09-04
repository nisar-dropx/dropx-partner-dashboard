import test from 'node:test';
import assert from 'node:assert/strict';
import {codAgeConcern,parseReviewCodLine,summarizeReviewCod,codAssociateKey,codFilterParams,filterReviewCod,readCodFilters,groupReviewCodAssociates} from './review-cod.ts';
const imported='2026-09-04T10:31:39Z';
const source=(extra={})=>({row_number:1,station_code:'GDRD',raw_data:{station_code:'GDRD',balance_due:'613.10',tracking_id:'T1',employee_name:'Associate A',performed_by_2:'123.0',age_bucket:'0-1 DAYS',cash_with_associate_dt:'2026-09-02 00:00:00',...extra},normalized_data:{}});
test('source buckets control colour: 0-1 neutral, 2+ red; unknown year uses date',()=>{
  assert.equal(codAgeConcern('0-1 DAYS','2026-09-01',imported),false);
  assert.equal(codAgeConcern('2 DAYS','2026-09-01',imported),true);
  assert.equal(codAgeConcern('2+ DAYS','2026-09-02',imported),true);
  assert.equal(codAgeConcern('3-4 DAYS','2026-08-31',imported),true);
  assert.equal(codAgeConcern('16-90 DAYS','2026-07-03',imported),true);
  assert.equal(codAgeConcern('2021','2026-05-01',imported),true);
});

test('bucket/date/DA drilldown and export share exact source amounts, including repeated TIDs',()=>{
  const a=parseReviewCodLine(source({balance_due:'10.11'}),'GDRD',imported);
  const b={...a,rowNumber:2,bucket:'2 DAYS',amount:20.22,overdue:true};
  const c={...b,rowNumber:3,amount:30.33,associate:'B',associateId:'234',trackingId:'T2'};
  const d={...b,rowNumber:4,amount:40.44,pendingDate:'2026-08-31'};
  const lines=[a,b,c,d];
  const bucket=filterReviewCod(lines,{bucket:'2 DAYS'});
  assert.equal(summarizeReviewCod(bucket).total,90.99);
  assert.equal(summarizeReviewCod(bucket).overdueAmount,90.99);
  const groups=groupReviewCodAssociates(bucket);
  assert.equal(groups[0].amount,60.66);
  assert.equal(groups[0].tidCount,1);
  for(const filters of [{},{bucket:'2 DAYS'},{bucket:'2 DAYS',day:b.pendingDate},{bucket:'2 DAYS',associate:codAssociateKey(b)},{bucket:'2 DAYS',day:b.pendingDate,associate:codAssociateKey(b)}]){
    const exported=readCodFilters(new URLSearchParams(codFilterParams(filters).toString()),lines);
    assert.deepEqual(filterReviewCod(lines,exported),filterReviewCod(lines,filters));
  }
  assert.deepEqual(filterReviewCod(lines,{bucket:'2 DAYS',day:b.pendingDate,associate:codAssociateKey(b)}),[b]);
  assert.equal(filterReviewCod(lines,{}).length,4,'clearing filters restores all lines');
});

test('unknown, ambiguous, empty and cross-selection filters never export the entire report',()=>{
  const line=parseReviewCodLine(source(),'GDRD',imported);
  for(const query of ['bucket=unknown','bucket=','bucket=0-1+DAYS&bucket=2+DAYS','day=2020-01-01','associate=unknown'])assert.throws(()=>readCodFilters(new URLSearchParams(query),[line]));
  assert.deepEqual(readCodFilters(new URLSearchParams(),[]),{});
  assert.equal(groupReviewCodAssociates([{...line,associateId:'a|b',associate:'c'},{...line,associateId:'a',associate:'b|c'}]).length,2);
});
test('zero clear is green; current pendency neutral; older pendency red',()=>{
  assert.equal(summarizeReviewCod([]).tone,'green');
  const young=parseReviewCodLine(source(),'GDRD',imported);
  assert.equal(summarizeReviewCod([young]).tone,'neutral');
  const old=parseReviewCodLine(source({age_bucket:'3-4 DAYS',balance_due:'100.25'}),'GDRD',imported);
  const summary=summarizeReviewCod([young,old]);
  assert.equal(summary.tone,'red');assert.equal(summary.total,713.35);assert.equal(summary.overdueAmount,100.25);
  assert.equal(summary.tidCount,1);assert.equal(summary.lineCount,2,'multiple order lines retained, not duplicated across imports');
  assert.equal(summary.days[0].amount,713.35);assert.equal(young.associateId,'123');
});
test('invalid source amounts fail rather than show zero; cross station denied',()=>{
  for(const value of [null,'','bad','-2'])assert.throws(()=>parseReviewCodLine(source({balance_due:value}),'GDRD',imported));
  assert.throws(()=>parseReviewCodLine(source(),'NLRF',imported));
  assert.throws(()=>parseReviewCodLine(source({station_code:'NLRF'}),'GDRD',imported));
  assert.equal(parseReviewCodLine(source({balance_due:'0'}),'GDRD',imported),null);
});
