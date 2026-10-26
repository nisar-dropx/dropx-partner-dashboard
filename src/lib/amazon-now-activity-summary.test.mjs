import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeActivity} from './amazon-now-activity-summary.ts';
const base={date:'2027-01-01',slots:['06:00','14:00','22:00'],isDue:()=>true,shiftPct:r=>r.pct??0,storePct:r=>r.pct??0,shifts:[],days:[]};
test('D−1 totals include missing slots and separate submission from acceptance',()=>{
 const a=summarizeActivity({...base,shifts:[{shift_date:'2027-01-01',shift_slot:'06:00',status:'accepted',outgoing_name:'A',pct:100},{shift_date:'2027-01-01',shift_slot:'14:00',status:'submitted',outgoing_name:'B',pct:100},{shift_date:'2026-12-31',shift_slot:'22:00',status:'open',outgoing_name:'Old'}],days:[{work_date:'2027-01-01',status:'submitted',pct:100}]});
 assert.equal(a.expected,3);assert.equal(a.submitted,2);assert.equal(a.accepted,1);assert.equal(a.awaiting,1);assert.match(a.slots[2].person,/not recorded/);assert.equal(a.slots[2].pct,null);assert(!a.slots.some(s=>s.person==='Old'));assert.equal(a.attention,true);
});
test('overnight shift is not called missing before its end',()=>{
 const a=summarizeActivity({...base,isDue:(_d,s)=>s!=='22:00'});assert.equal(a.expected,2);assert.equal(a.slots[2].due,false);
});
test('repeat flags are bounded to seven days and identify recorded owner only',()=>{
 const row={shift_slot:'06:00',status:'open',outgoing_user_id:'p',outgoing_name:'A'};
 const a=summarizeActivity({...base,shifts:[{...row,shift_date:'2027-01-01'},{...row,shift_date:'2026-12-31'},{...row,shift_date:'2026-12-20'},{...row,shift_date:'2027-01-02'},{...row,shift_date:'2026-12-30',status:'cancelled'}]});
 assert.match(a.slots[0].repeat,/2\/2/);assert.equal(a.slots[1].repeat,'');assert.match(a.trend,/D−2: 0\/3/);
});
test('older unfinished reports do not make a fully completed D−1 day pending',()=>{
 const a=summarizeActivity({...base,shifts:base.slots.map(shift_slot=>({shift_slot,shift_date:base.date,status:'accepted',pct:100})),days:[{work_date:base.date,status:'submitted',pct:100},{work_date:'2026-12-31',status:'open'}]});assert.equal(a.attention,false);assert.match(a.history,/1 recorded store day/);
});
