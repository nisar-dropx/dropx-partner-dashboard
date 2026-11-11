import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortfallValue,shortfallReminder,shortfallDailyKey,hasShortfallPendency} from './lm-cod-shortfall-policy.ts';

test('prior-day shortage is prompted one hour BEFORE pickup, never after',()=>{
 const check=slot=>shortfallReminder('2026-11-11','2026-11-12',slot,'10:30',false);
 assert.equal(check('09:00'),null);
 assert.equal(check('09:30'),'before-pickup');
 assert.equal(check('10:00'),'before-pickup');
 assert.equal(check('10:30'),null);
 assert.equal(check('11:00'),null);
 assert.equal(check('23:55'),null);
});
test('one station/day key covers every shortfall and no 11:55 prompt',()=>{
 assert.equal(shortfallDailyKey('2026-11-12'),'short-ledger:2026-11-12');
 assert.equal(shortfallReminder('2026-11-12','2026-11-12','11:00','10:30',false),'first');
 assert.equal(shortfallReminder('2026-11-12','2026-11-12','23:55','10:30',false),null);
});
test('configured 30-minute lead, recurring non-pickup day and unknown pickup',()=>{
 const check=slot=>shortfallReminder('2026-11-11','2026-11-12',slot,'10:30',false,30);
 assert.equal(check('09:30'),null);assert.equal(check('10:00'),'before-pickup');
 assert.equal(shortfallReminder('2026-11-11','2026-11-12','10:00','10:30',true),null);
 assert.equal(shortfallReminder('2026-11-11','2026-11-12','10:00',null,false),null);
 assert.equal(shortfallReminder('2026-11-11','2026-11-12','10:00','unknown',false),null);
});
test('shortage uses exact paise and excess is not a shortage',()=>{
 assert.equal(shortfallValue(150000,147500),2500);
 assert.equal(shortfallValue(100,110),0);
 assert.equal(shortfallValue(100.01,90),10.01);
 assert.equal(shortfallValue(NaN,90),null);
});

test('reminders ignore remaining pendency of ₹10 or less, including partial recovery',()=>{
 assert.equal(hasShortfallPendency(2500,2490),false);
 assert.equal(hasShortfallPendency(2500,2490.01),false);
 assert.equal(hasShortfallPendency(2500,2489.99),true);
 assert.equal(hasShortfallPendency(2500,2500),false);
 assert.equal(hasShortfallPendency(10,0),false);
 assert.equal(hasShortfallPendency(10.01,0),true);
});
