import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAttendance, attendanceCorrectionHint } from './attendance-summary.ts';

const context = { today: '2026-10-09' };
const row = (date, fields = {}) => ({ date, status: 'P', attendanceStatus: 'Full Day', inTime: '09:00', outTime: '18:00', workHours: '09:00', punchCount: 2, remark: '', ...fields });
const summarize = rows => summarizeAttendance(rows, context);

test('absence is not review even though either can be regularized; dates match every count', () => {
  const result = summarize([
    row('2026-10-03', { status: 'A', attendanceStatus: 'Absent', inTime: '', outTime: '', punchCount: 0 }),
    row('2026-10-04', { attendanceStatus: 'Needs Review', outTime: '', punchCount: 1 }),
    row('2026-10-05', { attendanceStatus: 'Half Day', workHours: '05:31' }),
    row('2026-10-06')
  ]);
  for (const key of ['fullDay', 'halfDay', 'absent', 'needsReview']) assert.equal(result[key], result.groups[key].length);
  assert.equal(result.absent, 1); assert.equal(result.needsReview, 1); assert.equal(result.trackedDays, 4);
  assert.deepEqual(result.groups.absent.map(x => x.date), ['2026-10-03']);
  assert.deepEqual(result.groups.needsReview.map(x => x.date), ['2026-10-04']);
});

test('paid/unpaid leave, holidays, weekly offs and future dates are not ordinary attendance or review', () => {
  const result = summarize([
    row('2026-10-01', { status: 'CL', statusKind: 'paid_leave', payDayType: 'paid_leave', lateMinutes: 30 }),
    row('2026-10-02', { status: 'LOP', statusKind: 'leave', payDayType: 'unpaid_leave' }),
    row('2026-10-03', { status: 'WO', attendanceStatus: 'Weekly Off', punchCount: 0, inTime: '', outTime: '' }),
    row('2026-10-04', { status: 'H', attendanceStatus: 'Holiday', punchCount: 0, inTime: '', outTime: '' }),
    row('2026-10-15', { status: 'A', attendanceStatus: 'Absent', punchCount: 0, inTime: '', outTime: '' })
  ]);
  assert.equal(result.trackedDays, 0); assert.equal(result.totalRows, 4); assert.equal(result.lateIn, 0);
});

test('worked rest day is present; an unpaired rest-day punch is not a completed full day', () => {
  const result = summarize([
    row('2026-10-08', { attendanceStatus: 'Present (Weekly Off)', payDayType: 'week_off', workHours: '12:57', punchCount: 3 }),
    row('2026-10-01', { attendanceStatus: 'Present (Weekly Off)', payDayType: 'week_off', outTime: '', punchCount: 1 })
  ]);
  assert.equal(result.fullDay, 1); assert.equal(result.needsReview, 0);
});

test('approved WFH is counted only after attendance credit finalizes; unknown rows are not full days', () => {
  const result = summarize([
    row('2026-10-01', { workMode: 'wfh', attendanceStatus: 'Present · WFH credit', punchCount: 0, inTime: '', outTime: '' }),
    row('2026-10-02', { workMode: 'wfh', status: 'PENDING', attendanceStatus: 'WFH approved · Finalizing', punchCount: 0, inTime: '', outTime: '' }),
    row('2026-10-03', { status: '', attendanceStatus: '', payDayType: 'no_record', punchCount: 0, inTime: '', outTime: '' })
  ]);
  assert.equal(result.fullDay, 1); assert.equal(result.needsReview, 0);
});

test('open current shift is not a completed full day or missing punch; prior closed date remains review', () => {
  const result = summarizeAttendance([
    row('2026-10-08', { attendanceStatus: 'Needs Review', outTime: '', punchCount: 1 }),
    row('2026-10-09', { attendanceStatus: 'Needs Review', outTime: '', punchCount: 1, lateMinutes: 20 })
  ], { ...context, openShiftDate: '2026-10-09' });
  assert.equal(result.fullDay, 0); assert.equal(result.needsReview, 1); assert.equal(result.inProgress, 1);
  assert.equal(result.lateIn, 1); assert.equal(result.misPunch, 1);
});

test('timing exceptions overlap outcomes, but never double-count the same date', () => {
  const records = [row('2026-10-02', { lateMinutes: 30, earlyOutMinutes: 10 }), row('2026-10-01'), row('2026-10-02', { lateMinutes: 30, earlyOutMinutes: 10 })];
  const original = JSON.stringify(records); const result = summarize(records);
  assert.equal(result.fullDay, 2); assert.equal(result.lateIn, 1); assert.equal(result.earlyOut, 1);
  assert.deepEqual(result.groups.all.map(x => x.date), ['2026-10-02', '2026-10-01']);
  assert.equal(JSON.stringify(records), original);
});

test('correction workflow is explained separately from attendance outcome', () => {
  assert.equal(attendanceCorrectionHint({ regularization: { status: 'pending_manager' } }), 'Correction pending manager');
  assert.equal(attendanceCorrectionHint({ regularization: { status: 'returned' } }), 'Correction returned');
  assert.match(attendanceCorrectionHint({ regularizationOpen: false }), /window closed/);
});
