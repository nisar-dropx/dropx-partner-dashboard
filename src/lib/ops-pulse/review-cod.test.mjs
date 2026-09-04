import test from 'node:test';
import assert from 'node:assert/strict';
import {codAgeOverTwo,parseReviewCodLine,summarizeReviewCod} from './review-cod.ts';
const imported='2026-09-04T10:31:39Z';
const source=(extra={})=>({row_number:1,station_code:'GDRD',raw_data:{station_code:'GDRD',balance_due:'613.10',tracking_id:'T1',employee_name:'Associate A',performed_by_2:'123.0',age_bucket:'0-1 DAYS',cash_with_associate_dt:'2026-09-02 00:00:00',...extra},normalized_data:{}});
test('source buckets control colour: 2 days neutral, 3-4 red; unknown year uses date',()=>{
  assert.equal(codAgeOverTwo('0-1 DAYS','2026-09-01',imported),false);
  assert.equal(codAgeOverTwo('2 DAYS','2026-09-01',imported),false);
  assert.equal(codAgeOverTwo('3-4 DAYS','2026-08-31',imported),true);
  assert.equal(codAgeOverTwo('16-90 DAYS','2026-07-03',imported),true);
  assert.equal(codAgeOverTwo('2021','2026-05-01',imported),true);
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
