import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRefreshStatus } from './board-refresh-status.ts';
test('attempted stations are never reported as saved or successful', () => {
  assert.match(
    boardRefreshStatus({ refreshRunning: true, refreshTotal: 35, refreshDone: 0, refreshPulled: 8, refreshFailed: 8 }),
    /0\/35 saved · pulled 8\/35 · 8 failed/,
  );
  assert.match(
    boardRefreshStatus({ refreshRunning: true, refreshTotal: 35, refreshDone: 8, refreshPulled: 8 }),
    /8\/35 saved(?!.*pulled)/,
  );
  assert.match(boardRefreshStatus({ refreshRunning: false, refreshTotal: 35, refreshDone: 8, refreshFailed: 27 }), /incomplete.*27 not updated/);
  assert.match(boardRefreshStatus({ refreshRunning: false, refreshTotal: 35, refreshDone: 8 }), /incomplete/);
  assert.match(boardRefreshStatus({ refreshRunning: false, refreshTotal: 35, refreshDone: 35 }), /complete · 35\/35 saved/);
});
