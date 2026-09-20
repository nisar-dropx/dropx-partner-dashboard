import test from 'node:test';import assert from 'node:assert/strict';
import {indiaScheduleToday,scheduleWeekStart,workforceOperatingDays} from './workforce-operating-schedule.ts';
const assignment={id:'first',operating_pincode:'600001',weekly_off_day:0,effective_from:'2026-09-01',effective_to:'2026-09-21'};
test('workforce area and weekly off are resolved per effective day, not today only',()=>{
 const rows=workforceOperatingDays([assignment,{...assignment,id:'second',operating_pincode:'600002',weekly_off_day:2,effective_from:'2026-09-22',effective_to:null}],'2026-09-20',4);
 assert.deepEqual(rows.map(r=>[r.date,r.operatingPincode,r.dayType]),[['2026-09-20','600001','weekly_off'],['2026-09-21','600001','working'],['2026-09-22','600002','weekly_off'],['2026-09-23','600002','working']]);
 assert.ok(rows.every(r=>r.shift===null&&!r.canSwap));
});
test('future-only assignment does not invent a current schedule and overlap fails closed',()=>{
 assert.equal(workforceOperatingDays([{...assignment,effective_from:'2026-09-21'}],'2026-09-20',2).length,1);
 assert.throws(()=>workforceOperatingDays([assignment,{...assignment,id:'duplicate'}],'2026-09-20',1),/conflicting/);
 assert.deepEqual(workforceOperatingDays([],'2026-09-20',30),[]);
});
test('calendar labels use Indian today and UTC date-only Monday boundaries',()=>{
 assert.equal(indiaScheduleToday(new Date('2026-09-20T20:00:00Z')),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-09-21'),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-09-27'),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-01-01'),'2025-12-29');
});
