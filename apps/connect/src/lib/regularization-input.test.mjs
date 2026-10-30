import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOvernightRegularizationPair,
  missingPunchReason,
  regularizationClock,
  regularizationTimeInput
} from './regularization-input.ts';

const base = { reason: 'other', currentIn: '', currentOut: '', requestedIn: '', requestedOut: '' };

test('absent-day Other gives actionable guidance, never null requested times', () => {
  assert.throws(() => regularizationTimeInput(base), /Select Missed both punches/);
  assert.throws(() => regularizationTimeInput({ ...base, currentIn: '09:00' }), /Select Missed OUT punch/);
  assert.throws(() => regularizationTimeInput({ ...base, currentOut: '18:00' }), /Select Missed IN punch/);
});
test('default missing reason follows recorded punches, including placeholders', () => {
  assert.equal(missingPunchReason('', '—'), 'missed_both');
  assert.equal(missingPunchReason('09:00', ''), 'missed_out');
  assert.equal(missingPunchReason('', '18:00'), 'missed_in');
  assert.equal(missingPunchReason('9:00:00', '18:00:00'), '');
});
test('Other preserves complete recorded times, not client-requested replacements', () => {
  assert.deepEqual(regularizationTimeInput({ ...base, currentIn: '09:15:00', currentOut: '18:10:00', requestedIn: '08:00', requestedOut: '22:00' }), {
    inTime: '09:15',
    outTime: '18:10',
    inTimeRpc: '09:15:00',
    outTimeRpc: '18:10:00',
    overnight: false
  });
});
test('both missing punches require actual times; blank, invalid and identical times fail', () => {
  for (const requestedIn of ['', '99:99', '09:62', '09:00 suffix']) {
    assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn, requestedOut: '18:00' }), /IN time/);
  }
  assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '09:00' }), /OUT time/);
  assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '09:00', requestedOut: '09:00' }), /cannot be the same/);
  assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '21:54', requestedOut: '21:54' }), /cannot be the same/);
  assert.deepEqual(regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '09:00', requestedOut: '18:00' }), {
    inTime: '09:00',
    outTime: '18:00',
    inTimeRpc: '09:00:00',
    outTimeRpc: '18:00:00',
    overnight: false
  });
});
test('overnight night-shift OUT before IN on the clock is accepted (HARIHARAN, 04 Oct)', () => {
  // IN 04/10 21:54, OUT 05/10 08:20 — regularize against the shift start date.
  assert.deepEqual(regularizationTimeInput({
    ...base,
    reason: 'missed_both',
    requestedIn: '21:54',
    requestedOut: '08:20'
  }), { inTime: '21:54', outTime: '08:20', inTimeRpc: '21:54:00', outTimeRpc: '08:20:00', overnight: true });
  assert.equal(isOvernightRegularizationPair('21:54', '08:20'), true);
  assert.equal(isOvernightRegularizationPair('09:00', '18:00'), false);
  assert.equal(isOvernightRegularizationPair('09:00', '09:00'), false);

  // Missed OUT only: keep evening IN, claim morning OUT next day.
  assert.deepEqual(regularizationTimeInput({
    ...base,
    reason: 'missed_out',
    currentIn: '21:54',
    requestedOut: '8:20'
  }), { inTime: '21:54', outTime: '08:20', inTimeRpc: '21:54:00', outTimeRpc: '08:20:00', overnight: true });

  // Incorrect OUT on an overnight shift.
  assert.deepEqual(regularizationTimeInput({
    ...base,
    reason: 'incorrect_out',
    currentIn: '21:54:00',
    currentOut: '07:00',
    requestedOut: '08:20'
  }), { inTime: '21:54', outTime: '08:20', inTimeRpc: '21:54:00', outTimeRpc: '08:20:00', overnight: true });

  // Just after midnight out of a late start.
  assert.deepEqual(regularizationTimeInput({
    ...base,
    reason: 'missed_both',
    requestedIn: '23:59',
    requestedOut: '00:00'
  }), { inTime: '23:59', outTime: '00:00', inTimeRpc: '23:59:00', outTimeRpc: '00:00:00', overnight: true });

  // Near-24h overnight pair stays valid; policy length is applied after approval.
  assert.deepEqual(regularizationTimeInput({
    ...base,
    reason: 'missed_both',
    requestedIn: '09:00',
    requestedOut: '08:59'
  }), { inTime: '09:00', outTime: '08:59', inTimeRpc: '09:00:00', outTimeRpc: '08:59:00', overnight: true });
});
test('single-punch corrections and permissions retain the untouched punch', () => {
  for (const reason of ['missed_in', 'incorrect_in', 'late_in_permission']) {
    assert.deepEqual(regularizationTimeInput({ ...base, reason, currentOut: '18:00', requestedIn: '09:00', requestedOut: '23:00' }), {
      inTime: '09:00',
      outTime: '18:00',
      inTimeRpc: '09:00:00',
      outTimeRpc: '18:00:00',
      overnight: false
    });
    assert.throws(() => regularizationTimeInput({ ...base, reason, requestedIn: '09:00' }), /Missed both punches/);
  }
  for (const reason of ['missed_out', 'incorrect_out', 'early_out_permission']) {
    assert.deepEqual(regularizationTimeInput({ ...base, reason, currentIn: '09:00', requestedIn: '01:00', requestedOut: '18:00' }), {
      inTime: '09:00',
      outTime: '18:00',
      inTimeRpc: '09:00:00',
      outTimeRpc: '18:00:00',
      overnight: false
    });
    assert.throws(() => regularizationTimeInput({ ...base, reason, requestedOut: '18:00' }), /Missed both punches/);
  }
  assert.equal(regularizationClock('00:00'), '00:00');
  assert.equal(regularizationClock('24:00'), '');
  assert.equal(regularizationClock('--:--'), '');
  assert.equal(missingPunchReason('--:--', '--:--'), 'missed_both');
});
