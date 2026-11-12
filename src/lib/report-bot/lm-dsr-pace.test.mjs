import test from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_DSR_PACE,dsrPaceTarget,liveDsrStyle,parseDsrPace} from './lm-dsr-pace.ts';
test('40% at 10:30 IST is healthy but behind at 20:00',()=>{
 const morning=dsrPaceTarget('2026-11-12T05:00:00Z',DEFAULT_DSR_PACE);
 assert.equal(morning,25);assert.equal(liveDsrStyle('40%',morning).color,'#14532d');
 assert.equal(liveDsrStyle('40%',dsrPaceTarget('2026-11-12T14:30:00Z',DEFAULT_DSR_PACE)).color,'#991b1b');
});
test('neutral before dispatch; unavailable percentage not zero; time interpolation',()=>{
 assert.equal(liveDsrStyle(0,0).color,'#1e40af');assert.equal(liveDsrStyle('—',25),null);
 assert.equal(dsrPaceTarget('2026-11-12T05:45:00Z',DEFAULT_DSR_PACE),32.5);
 assert.throws(()=>parseDsrPace('10:00=80,12:00=20'));
 assert.throws(()=>parseDsrPace('24:00=90,25:00=100'));
});
