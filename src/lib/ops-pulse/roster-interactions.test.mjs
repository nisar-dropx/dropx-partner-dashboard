import test from 'node:test';
import assert from 'node:assert/strict';
import { findRosterWeekOffCapBreach } from './roster-interactions.ts';

const joseph = 'contractor:d0905';
const shift = (id = 'SHIFT_09_00') => ({ dayType: 'working', shiftId: id, notes: null });
const off = () => ({ dayType: 'weekly_off', shiftId: null, notes: null });
const weekOff = { tool: { kind: 'weekly_off' } };

test('screenshot case: a second Week Off in the same Mon-Sun week is refused', () => {
  const current = new Map([
    [`${joseph}:2026-09-28`, off()],
    [`${joseph}:2026-09-29`, shift()],
    [`${joseph}:2026-09-30`, shift()]
  ]);
  assert.deepEqual(
    findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-09-29`, payload: weekOff }]),
    { personKey: joseph, weekStart: '2026-09-28' }
  );
});

test('the first Week Off of the week is allowed', () => {
  const current = new Map([[`${joseph}:2026-09-28`, shift()]]);
  assert.equal(findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-09-29`, payload: weekOff }]), null);
});

test('Apply to selected: Week Off on two days of one week is refused as a batch', () => {
  const current = new Map();
  const drops = ['2026-09-28', '2026-10-02'].map((date) => ({ targetKey: `${joseph}:${date}`, payload: weekOff }));
  assert.deepEqual(findRosterWeekOffCapBreach(current, drops), { personKey: joseph, weekStart: '2026-09-28' });
});

test('dragging an existing Week Off to another day of the same week is a move, not a second one', () => {
  const current = new Map([[`${joseph}:2026-09-28`, off()], [`${joseph}:2026-09-30`, shift()]]);
  const move = { tool: { kind: 'weekly_off' }, sourceKey: `${joseph}:2026-09-28` };
  assert.equal(findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-09-30`, payload: move }]), null);
});

test('Sunday and the next Monday are different weeks', () => {
  const current = new Map([[`${joseph}:2026-10-04`, off()]]);
  assert.equal(findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-10-05`, payload: weekOff }]), null);
});

test('replacing an extra Week Off with a shift is always allowed (lets HR fix old data)', () => {
  const current = new Map([[`${joseph}:2026-09-28`, off()], [`${joseph}:2026-09-29`, off()]]);
  const toShift = { tool: { kind: 'shift', shiftId: 'SHIFT_09_00' } };
  assert.equal(findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-09-29`, payload: toShift }]), null);
});

test("another person's Week Off in the same week does not count", () => {
  const current = new Map([['employee:other:2026-09-28', off()]]);
  assert.equal(findRosterWeekOffCapBreach(current, [{ targetKey: `${joseph}:2026-09-29`, payload: weekOff }]), null);
});
