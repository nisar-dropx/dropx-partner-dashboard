import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewsForPerformanceDay,earlierPendingReviews,reviewPendingPage,reviewLink} from './review-periods.ts';
test('selected-day reviews and earlier pending reviews never mix',()=>{
  const rows=[{source_date:'2026-09-03',review_type:'daily_operations',status:'in_review'},{source_date:'2026-09-02',review_type:'daily_operations',status:'open'},{source_date:'2026-09-01',review_type:'daily_operations',status:'closed'},{source_date:'2026-09-03',review_type:'weekly_sales',status:'open'}];
  assert.deepEqual(reviewsForPerformanceDay(rows,'2026-09-03'),[rows[0]]);
  assert.deepEqual(earlierPendingReviews(rows,'2026-09-03'),[rows[1]]);
});
test('dated links and page input stay bounded',()=>{
  for(const value of ['-1','bad','0','1.5'])assert.equal(reviewPendingPage(value),1);
  assert.equal(reviewPendingPage('2'),2);
  assert.match(reviewLink('2026-09-03','NLRF',2),/date=2026-09-03/);
  assert.match(reviewLink('2026-09-03','NLRF',2),/pendingPage=2/);
});
