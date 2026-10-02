import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPunchReason, regularizationClock, regularizationTimeInput } from './regularization-input.ts';

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
  assert.deepEqual(regularizationTimeInput({ ...base, currentIn: '09:15:00', currentOut: '18:10:00', requestedIn: '08:00', requestedOut: '22:00' }), { inTime: '09:15', outTime: '18:10' });
});
test('both missing punches require actual times; blank, invalid and reversed times fail', () => {
  for (const requestedIn of ['', '99:99', '09:62', '09:00 suffix']) {
    assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn, requestedOut: '18:00' }), /IN time/);
  }
  assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '09:00' }), /OUT time/);
  assert.throws(() => regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '18:00', requestedOut: '09:00' }), /after IN/);
  assert.deepEqual(regularizationTimeInput({ ...base, reason: 'missed_both', requestedIn: '09:00', requestedOut: '18:00' }), { inTime: '09:00', outTime: '18:00' });
});
test('single-punch corrections and permissions retain the untouched punch', () => {
  for (const reason of ['missed_in', 'incorrect_in', 'late_in_permission']) {
    assert.deepEqual(regularizationTimeInput({ ...base, reason, currentOut: '18:00', requestedIn: '09:00', requestedOut: '23:00' }), { inTime: '09:00', outTime: '18:00' });
    assert.throws(() => regularizationTimeInput({ ...base, reason, requestedIn: '09:00' }), /Missed both punches/);
  }
  for (const reason of ['missed_out', 'incorrect_out', 'early_out_permission']) {
    assert.deepEqual(regularizationTimeInput({ ...base, reason, currentIn: '09:00', requestedIn: '01:00', requestedOut: '18:00' }), { inTime: '09:00', outTime: '18:00' });
    assert.throws(() => regularizationTimeInput({ ...base, reason, requestedOut: '18:00' }), /Missed both punches/);
  }
  assert.equal(regularizationClock('00:00'), '00:00');
  assert.equal(regularizationClock('24:00'), '');
});
