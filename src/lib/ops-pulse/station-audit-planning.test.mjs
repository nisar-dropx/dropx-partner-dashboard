import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditTimestamp, auditDay, auditMonthRange, auditPlanColumns, auditCycle, auditDuration, isFastAudit, stationCanSeeAudit, validAuditDate, auditTone } from './station-audit-planning.ts';
const physical = { cadence_unit: 'monthly', required_count: 2, scheduling_config: { period_slots: [{ code: 'first_half', label: 'First half', start_day: 1 }, { code: 'second_half', label: 'Second half', start_day: 16 }] } };
const cod = { cadence_unit: 'weekly', required_count: 1, scheduling_config: { period_slots: [{ code: 'weekly', label: 'Weekly coverage' }] } };
test('India calendar groups midnight correctly and validates real dates', () => {
  assert.equal(auditTimestamp('2026-10-05', '00:05'), '2026-10-04T18:35:00.000Z');
  assert.equal(auditDay('2026-10-04T18:35:00.000Z'), '2026-10-05');
  for (const day of ['2026-02-29', '2026-13-05', '2026-04-31']) assert.equal(validAuditDate(day), false);
  assert.throws(() => auditTimestamp('2026-10-05', '25:00'));
  assert.throws(() => auditMonthRange('2026-13'));
  assert.equal(auditMonthRange('2028-02').to, '2028-02-29');
});
test('monthly matrix matches existing programme keys and changes with master frequency', () => {
  const columns = auditPlanColumns(physical, '2026-10');
  assert.deepEqual(columns.map(({ code, date }) => [code, date]), [['first_half', '2026-10-01'], ['second_half', '2026-10-16']]);
  for (const column of columns) assert.equal(auditCycle(physical, column.date, column.code).cycleKey, column.cycleKey);
  assert.equal(auditPlanColumns({ ...physical, required_count: 3 }, '2026-10').length, 3);
  assert.throws(() => auditCycle(physical, '2026-10-05', 'arbitrary-slot'));
});
test('weekly matrix has one slot per ISO week, including cross-month/year weeks', () => {
  const columns = auditPlanColumns(cod, '2026-10'); assert.equal(columns.length, 5);
  assert.equal(columns[0].cycleKey, auditCycle(cod, '2026-09-28', 'weekly').cycleKey);
  assert.equal(auditPlanColumns(cod, '2027-01')[0].cycleKey, '2026-W53');
  assert.equal(new Set(columns.map((column) => column.key)).size, columns.length);
});
test('fast audit flag is inclusive at 10 minutes; missing/invalid timing is never zero', () => {
  const audit = { status_code: 'closed', started_at: '2026-10-05T00:00:00Z', completed_at: '2026-10-05T00:10:00Z' };
  assert.equal(auditDuration(audit), 10); assert.equal(isFastAudit(audit), true);
  assert.equal(isFastAudit({ ...audit, completed_at: '2026-10-05T00:10:01Z' }), false);
  for (const input of [{ ...audit, started_at: null }, { ...audit, completed_at: null }, { ...audit, started_at: 'bad' }, { ...audit, completed_at: '2026-10-04T00:00:00Z' }]) { assert.equal(auditDuration(input), null); assert.equal(isFastAudit(input), false); }
});
test('station views cannot expose scheduled/in-progress surprise audits even with malformed completion data', () => {
  for (const status_code of ['scheduled', 'in_progress']) assert.equal(stationCanSeeAudit({ status_code, completed_at: '2026-10-05', station_response_status: 'requested' }), false);
  assert.equal(stationCanSeeAudit({ status_code: 'closed', completed_at: null }), false);
  for (const status_code of ['closed', 'under_review']) assert.equal(stationCanSeeAudit({ status_code, completed_at: '2026-10-05' }), true);
  assert.equal(stationCanSeeAudit({ status_code: 'awaiting_station_response', completed_at: '2026-10-05', station_response_status: 'requested' }), true);
  assert.equal(auditTone({ status_code: 'under_review' }), 'pending');
});
