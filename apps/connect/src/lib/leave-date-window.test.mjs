import test from 'node:test';
import assert from 'node:assert/strict';
import { compOffValidUntil, leaveDatesOutsideWindow, leaveDateWindow } from './leave-date-window.ts';

test('CL/SL: whole current month and next month (mid-month)', () => {
  assert.deepEqual(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2026-09-25' }), { earliest: '2026-09-01', latest: '2026-10-31' });
  assert.deepEqual(leaveDateWindow({ code: 'SICK', balanceMode: 'annual_balance', today: '2026-09-25' }), { earliest: '2026-09-01', latest: '2026-10-31' });
});

test('CL/SL: previous month allowed only on the 1st and 2nd', () => {
  assert.equal(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2026-10-01' }).earliest, '2026-09-01');
  assert.equal(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2026-10-02' }).earliest, '2026-09-01');
  assert.equal(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2026-10-03' }).earliest, '2026-10-01');
});

test('CL/SL: year boundary', () => {
  assert.deepEqual(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2026-12-20' }), { earliest: '2026-12-01', latest: '2027-01-31' });
  assert.equal(leaveDateWindow({ code: 'CASUAL', balanceMode: 'annual_balance', today: '2027-01-02' }).earliest, '2026-12-01');
});

test('other leave types keep today onwards', () => {
  assert.deepEqual(leaveDateWindow({ code: 'LOP', balanceMode: 'unlimited_unpaid', today: '2026-09-25' }), { earliest: '2026-09-25', latest: null });
});

test('week-off comp-off: from the day after the worked week off to month end (SREEKANTH, 13 Sep)', () => {
  const validUntil = compOffValidUntil('2026-09-13', 'comp_off_earned_week_off', { weekOffLapsesMonthly: true, holidayLapseDays: null }, '2026-10-31');
  assert.equal(validUntil, '2026-09-30');
  const window = leaveDateWindow({ code: 'WOFFCOMP', balanceMode: 'earned_balance', today: '2026-09-25', credits: [{ referenceDate: '2026-09-13', validUntil }] });
  assert.deepEqual(window, { earliest: '2026-09-14', latest: '2026-09-30' });
  assert.equal(leaveDatesOutsideWindow(window, '2026-09-13', '2026-09-13', 'Week-off Comp Off'), 'Week-off Comp Off can start on 14/09/2026 at the earliest.');
  assert.equal(leaveDatesOutsideWindow(window, '2026-09-14', '2026-09-14', 'Week-off Comp Off'), null);
  assert.equal(leaveDatesOutsideWindow(window, '2026-10-01', '2026-10-01', 'Week-off Comp Off'), 'Week-off Comp Off must end by 30/09/2026.');
});

test('comp-off: lapsed credits give no window', () => {
  const window = leaveDateWindow({ code: 'WOFFCOMP', balanceMode: 'earned_balance', today: '2026-10-05', credits: [{ referenceDate: '2026-09-13', validUntil: '2026-09-30' }] });
  assert.equal(window, null);
  assert.equal(leaveDatesOutsideWindow(window, '2026-10-06', '2026-10-06', 'Week-off Comp Off'), 'No Week-off Comp Off is available to use right now.');
});

test('holiday comp-off (source comp_off_earned) lapses after its configured days', () => {
  assert.equal(compOffValidUntil('2026-09-10', 'comp_off_earned', { weekOffLapsesMonthly: true, holidayLapseDays: 30 }, '2026-10-31'), '2026-10-10');
});

test('a comp-off credit that never lapses is usable until the no-lapse limit', () => {
  assert.equal(compOffValidUntil('2026-09-10', 'comp_off_earned', { weekOffLapsesMonthly: true, holidayLapseDays: null }, '2026-10-31'), '2026-10-31');
  assert.equal(compOffValidUntil('2026-09-13', 'comp_off_earned_week_off', { weekOffLapsesMonthly: false, holidayLapseDays: null }, '2026-10-31'), '2026-10-31');
});
