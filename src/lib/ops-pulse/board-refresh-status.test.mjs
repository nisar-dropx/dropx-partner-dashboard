import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRefreshReasonNote, boardRefreshStatus } from './board-refresh-status.ts';

test('running refresh names retrying stations instead of failed', () => {
  assert.match(
    boardRefreshStatus({
      refreshRunning: true,
      refreshTotal: 35,
      refreshDone: 31,
      refreshPulled: 35,
      refreshFailed: 4,
      refreshFailedStations: [
        { stationCode: 'KGQA', retrying: true, reason: 'Amazon Ageing read incomplete' },
        { stationCode: 'GDRD', retrying: true, reason: 'Amazon Ageing read incomplete' },
        { stationCode: 'KOZA', retrying: true },
        { stationCode: 'KDJE', retrying: true },
      ],
    }),
    /Refreshing · 31\/35 saved · retrying 4 \(GDRD, KDJE, KGQA, KOZA\)/,
  );
  assert.doesNotMatch(
    boardRefreshStatus({
      refreshRunning: true,
      refreshTotal: 35,
      refreshDone: 31,
      refreshFailed: 4,
      refreshFailedStations: [{ stationCode: 'KGQA', retrying: true }],
    }),
    /failed/i,
  );
});

test('running refresh without leftovers stays quiet on pulled gap under 3', () => {
  assert.equal(
    boardRefreshStatus({ refreshRunning: true, refreshTotal: 35, refreshDone: 8, refreshPulled: 8 }),
    'Refreshing · 8/35 saved',
  );
  assert.match(
    boardRefreshStatus({ refreshRunning: true, refreshTotal: 35, refreshDone: 0, refreshPulled: 8 }),
    /Refreshing · 0\/35 saved · pulled 8\/35/,
  );
});

test('complete with leftovers names stations and keeps previous-data trust', () => {
  assert.match(
    boardRefreshStatus({
      refreshRunning: false,
      refreshTotal: 35,
      refreshDone: 31,
      refreshFailed: 4,
      refreshFailedStations: [
        { stationCode: 'KGQA', retrying: false },
        { stationCode: 'GDRD', retrying: false },
        { stationCode: 'KOZA', retrying: false },
        { stationCode: 'KDJE', retrying: false },
      ],
    }),
    /Refresh complete · 31\/35 saved · 4 not updated:.*previous data kept/,
  );
  assert.match(
    boardRefreshStatus({ refreshRunning: false, refreshTotal: 35, refreshDone: 8, refreshFailed: 27 }),
    /not updated · previous data kept/,
  );
  assert.equal(
    boardRefreshStatus({ refreshRunning: false, refreshTotal: 35, refreshDone: 35 }),
    'Refresh complete · 35/35 saved',
  );
});

test('reason note lists first few station reasons', () => {
  assert.equal(
    boardRefreshReasonNote([
      { stationCode: 'KGQA', reason: 'Amazon Ageing read incomplete; retry required' },
      { stationCode: 'GDRD', reason: 'Amazon DSR read incomplete' },
    ]),
    'KGQA: Amazon Ageing read incomplete · GDRD: Amazon DSR read incomplete',
  );
});
