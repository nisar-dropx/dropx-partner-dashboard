import test from 'node:test';
import assert from 'node:assert/strict';
import { boardSourceStatus, withBoardSourceStatus } from './board-source-status.ts';

test('missing and overnight snapshots cannot be presented as fresh zero activity', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const missing = { stationCode: 'A', businessDate: '2026-11-05', hasSnapshot: false, fetchedAt: null };
  const empty = { stationCode: 'B', businessDate: '2026-11-05', hasSnapshot: true, fetchedAt: '2026-11-05T11:45:00Z' };
  assert.equal(boardSourceStatus(missing, now), 'missing');
  assert.equal(boardSourceStatus({ ...empty, fetchedAt: '2026-11-04T20:00:00Z' }, now), 'older');
  assert.equal(boardSourceStatus({ ...empty, businessDate: '2026-11-04', fetchedAt: '2026-11-04T20:00:00Z' }, now), 'current');
  const report = withBoardSourceStatus({ headers: ['Station', 'Location', 'Total'], rows: [
    [{text:'A'}, {text:'Station A'}, {text:'0'}], [{text:'B'}, {text:'Station B'}, {text:'0'}],
  ] }, [missing, empty], now);
  assert.equal(report.rows[0][2].text, '—');
  assert.equal(report.rows[0][3].text, 'Not fetched');
  assert.equal(report.rows[1][2].text, '0');
  assert.match(report.rows[1][3].text, /17:15/);
});
