import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchSlotDue,dispatchSlotUpcoming} from './lm-dispatch-window.ts';
const day='2026-11-12',at=s=>Date.parse(`${day}T${s}:00+05:30`);
test('regional retry survives slow refresh but cannot replay an older slot',()=>{
 assert.equal(dispatchSlotDue(day,'10:00',['10:00','12:00'],'dsr',at('10:25')),true);
 assert.equal(dispatchSlotDue(day,'10:00',['10:00','12:00'],'dsr',at('10:30')),true);
 assert.equal(dispatchSlotDue(day,'10:00',['10:00','10:10'],'dsr',at('10:10')),false);
 assert.equal(dispatchSlotDue(day,'23:30',['23:30'],'eod',at('23:55')),true);
 assert.equal(dispatchSlotDue(day,'10:00',['10:00'],'dsr',at('09:59')),false);
});
test('prewarm is bounded to the ten minutes before the configured slot',()=>{
 assert.equal(dispatchSlotUpcoming(day,'10:00',at('09:57')),true);
 assert.equal(dispatchSlotUpcoming(day,'10:00',at('09:49')),false);
 assert.equal(dispatchSlotUpcoming(day,'10:00',at('10:00')),false);
});

test('cash and scrub failures can recover within the current slot but never replay an older slot',()=>{
 for(const report of ['bank','scrub']){
  assert.equal(dispatchSlotDue(day,'20:00',['20:00','22:00'],report,at('21:59')),true);
  assert.equal(dispatchSlotDue(day,'20:00',['20:00','22:00'],report,at('22:00')),false);
  assert.equal(dispatchSlotDue(day,'22:00',['22:00'],report,at('23:59')),true);
  assert.equal(dispatchSlotDue(day,'22:00',['22:00'],report,Date.parse('2026-11-13T00:00:00+05:30')),false);
 }
});

test('live report recovery is bounded to one hour',()=>{assert.equal(dispatchSlotDue(day,'08:00',['08:00','12:00'],'dsr',at('08:59')),true);assert.equal(dispatchSlotDue(day,'08:00',['08:00','12:00'],'dsr',at('09:00')),false);});
