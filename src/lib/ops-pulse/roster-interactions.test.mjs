import test from 'node:test';
import assert from 'node:assert/strict';
import { findRosterWeekOffCapBreach, isPastRosterWeek, rosterMonthMinWeekStart, rosterMonthMaxWeekStart } from './roster-interactions.ts';

test('month week floor is the Monday on or before the 1st; forward reaches 4 weeks ahead', () => {
  assert.equal(rosterMonthMinWeekStart('2026-10-28'), '2026-09-28');
  // 4 weeks from 2026-10-28 is 2026-11-25 (Wednesday) → Monday on or before is 2026-11-23.
  assert.equal(rosterMonthMaxWeekStart('2026-10-28'), '2026-11-23');
  assert.equal(isPastRosterWeek('2026-09-28', '2026-10-26'), true);
  assert.equal(isPastRosterWeek('2026-10-26', '2026-10-26'), false);
});

test('forward 4-week cap can cross into the next calendar year in late December', () => {
  // 2026-12-15 + 28 days = 2027-01-12 (Tuesday) → Monday on or before is 2027-01-11.
  assert.equal(rosterMonthMaxWeekStart('2026-12-15'), '2027-01-11');
  assert.equal(rosterMonthMinWeekStart('2027-01-05'), '2026-12-28');
});

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
