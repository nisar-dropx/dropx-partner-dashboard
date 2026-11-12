import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scrubEddProgress,nextScrubThreshold,progressScrubAlert} from './lm-scrub-progress.ts';
const day='2026-11-12',at=t=>Date.parse(day+'T'+t+':00+05:30');
const progress={eddClearedPct:95,roadCompletedPct:94,edd95Since:at('10:15')};
test('at-station waits two hours after 95%, without a fixed afternoon deadline',()=>{
 assert.equal(progressScrubAlert(day,at('12:14'),0,0,progress).pending,false);
 assert.equal(progressScrubAlert(day,at('12:15'),0,0,progress).pending,true);
 assert.equal(progressScrubAlert(day,at('18:00'),0,0,{...progress,eddClearedPct:94,edd95Since:null}).pending,false);
});
test('completed scrub stops reminders; 95% road completion or 10PM triggers only unfinished road scrub',()=>{
 assert.equal(progressScrubAlert(day,at('16:00'),1,0,{...progress,roadCompletedPct:95}).pending,true);
 assert.equal(progressScrubAlert(day,at('16:00'),1,1,{...progress,roadCompletedPct:95}).pending,false);
 assert.equal(progressScrubAlert(day,at('22:00'),1,0,{eddClearedPct:null,roadCompletedPct:null,edd95Since:null}).pending,true);
 assert.equal(progressScrubAlert(day,at('21:59'),1,0,{eddClearedPct:null,roadCompletedPct:null,edd95Since:null}).pending,false);
});
test('new pending wave resets the at-station grace; no zero-denominator clearance',()=>{
 assert.equal(nextScrubThreshold(at('10:15'),94,at('12:00')),null);
 assert.equal(nextScrubThreshold(null,95,at('12:00')),at('12:00'));
 assert.equal(nextScrubThreshold(at('10:15'),98,at('12:00')),at('10:15'));
 assert.equal(scrubEddProgress([],day).clearedPct,null);
});
test('EDD progress deduplicates physical/pending TIDs, excluding past and future EDD',()=>{
 const r=(trackingId,bucket,edd=day)=>({trackingId,bucket,edd});
 const rows=[r('a','BoardPhysical'),r('a','BoardPendingToday'),r('b','BoardOOR'),r('b','BoardOOR'),r('c','BoardDelivered'),r('d','BoardPhysical','2026-11-13'),r('e','BoardPhysical','2026-11-11')];
 assert.deepEqual(scrubEddProgress(rows,day),{total:3,pending:1,clearedPct:100*2/3});
});
