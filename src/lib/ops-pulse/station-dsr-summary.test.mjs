import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARD_TID, mapBoardTidExportRows } from './station-board-tids.ts';
import { stationDsrMetricRows, stationDsrReportRows, summarizeStationDsrRows, STATION_DSR_PENDING_HEADER, STATION_DSR_PHYSICAL_HEADER } from './station-dsr-summary.ts';
import { dsrStationTable } from './board-detail-report.ts';
import { normalizeBoard } from './station-board.ts';
const row = (trackingId, sourceBucket, edd='2026-11-04',stationCode='STATION') => ({stationCode,trackingId,sourceBucket,currentState:'INDUCTED',status:'INDUCTED',edd,driverId:'',driverName:''});

test('legacy all-date EDD and age-only feeds cannot masquerade as verified inventory',()=>{
 const legacy=[row('FUTURE',BOARD_TID.EDD,'2026-11-05'),row('TODAY',BOARD_TID.EDD),row('OLD',BOARD_TID.AGEING,'2026-11-03')];
 assert.deepEqual(summarizeStationDsrRows(legacy,'2026-11-04'),{});
 assert.deepEqual(stationDsrMetricRows(legacy,'STATION','2026-11-04','eddPending'),[]);
 assert.deepEqual(summarizeStationDsrRows([],'2026-11-04',['EMPTY']),{EMPTY:{eddPending:0,physicalAtStation:0}});
});

test('physical is all stock; today pending is a subset and not reduced by mere driver assignment',()=>{
 const rows=[row('DUE',BOARD_TID.PHYSICAL),row('DUE',BOARD_TID.PENDING_TODAY),row('DUE',BOARD_TID.OTHER),row('FUTURE',BOARD_TID.PHYSICAL,'2026-11-05'),row('OVERDUE',BOARD_TID.PHYSICAL,'2026-11-03'),row('RETURNED',BOARD_TID.PHYSICAL),row('RETURNED',BOARD_TID.FAILED)];
 assert.deepEqual(summarizeStationDsrRows(rows,'2026-11-04').STATION,{eddPending:1,physicalAtStation:4});
 assert.equal(stationDsrMetricRows(rows,'STATION','2026-11-05','eddPending').length,0);
 assert.equal(stationDsrMetricRows(rows,'STATION','2026-11-04','assigned').length,2);
});

test('TID deduplication stays within station and trims whitespace',()=>{
 const rows=[row(' A ',BOARD_TID.PHYSICAL),row('A',BOARD_TID.PHYSICAL),row('A',BOARD_TID.PHYSICAL,'2026-11-04','SECOND')];
 assert.equal(stationDsrMetricRows(rows,'STATION','2026-11-04','physicalAtStation').length,1);
 assert.deepEqual(Object.values(summarizeStationDsrRows(rows,'2026-11-04')).map(r=>r.physicalAtStation),[1,1]);
});

test('table, clickable TIDs and Excel agree without adding overlapping stock and outcome counts',()=>{
 const fixture=[row('DUE',BOARD_TID.PHYSICAL),row('DUE',BOARD_TID.PENDING_TODAY),row('DUE',BOARD_TID.OTHER),row('FUTURE',BOARD_TID.PHYSICAL,'2026-11-05'),row('BACK',BOARD_TID.PHYSICAL),row('BACK',BOARD_TID.FAILED),row('DONE',BOARD_TID.DELIVERED)];
 const rows=mapBoardTidExportRows(fixture.map(r=>({...r,bucket:r.sourceBucket,state:r.currentState})),'dsr-station');
 const summary=summarizeStationDsrRows(rows,'2026-11-04');
 const stations=[{stationCode:'STATION',board:normalizeBoard({stationInventoryVersion:1,daDsr:[{driverId:'DA',total:3,delivered:1,failed:1,other:1}]})}];
 const table=dsrStationTable(stations,{},false,summary);
 assert.equal(stations[0].board.stationInventoryVersion,1);
 assert.deepEqual(table.headers.slice(2,4),[STATION_DSR_PENDING_HEADER,STATION_DSR_PHYSICAL_HEADER]);
 const exported=stationDsrReportRows(rows,'2026-11-04');
 assert.equal(exported.length,4);
 assert.equal(new Set(exported.map(r=>r.trackingId)).size,4);
 assert.equal(exported.filter(r=>r.eddPending).length,Number(table.rows[0][2].text));
 assert.equal(exported.filter(r=>r.physicalAtStation).length,Number(table.rows[0][3].text));
 assert.equal(exported.filter(r=>r.assigned).length,Number(table.rows[0][4].text));
 assert.equal(exported.find(r=>r.trackingId==='BACK').dsrOutcome,'Failed');
 assert.equal(exported.find(r=>r.trackingId==='BACK').physicalAtStation,true);
 assert.equal(exported.find(r=>r.trackingId==='BACK').eddPending,false);
});
