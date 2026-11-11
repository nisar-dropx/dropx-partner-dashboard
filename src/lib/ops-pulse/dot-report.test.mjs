import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyDot,parseDotTotals,sumDot,matchesDotMetric} from './dot-metrics.ts';
import {dotStationTable} from './dot-report.ts';
import {normalizeBoard,daDsrForView} from './station-board.ts';
import {mapBoardTidExportRows} from './station-board-tids.ts';
test('weighted DOT, strict missing data and station totals',()=>{
 const a={...emptyDot(),total:2,delivered:1};const b={...emptyDot(),total:8,delivered:8};
 assert.equal(sumDot([a,b]).dotPct,90);assert.equal(parseDotTotals({total:0}),undefined);
 const stations=[{stationCode:'KLZA',board:normalizeBoard({dotVersion:1,dotPremium:a})},{stationCode:'GDRD',board:normalizeBoard({dotVersion:1,dotPremium:b})}];
 const report=dotStationTable(stations,'premium');assert.equal(report.rows.at(-1).at(-1).text,'90.00%');
 assert.equal(dotStationTable([...stations,{stationCode:'KTUR',board:normalizeBoard({})}],'premium').rows.at(-1)[1].text,'—');
});
test('DOT drilldown excludes DSR-only, future inventory and other classes; flags match counters',()=>{
 const rows=[{stationCode:'KLZA',trackingId:'1',bucket:'BoardDotFailed',shipOption:'EXP',state:'AT_STATION',edd:'2026-11-04',dotDispatched:true,dotAtStation:true},
 {stationCode:'KLZA',trackingId:'2',bucket:'BoardDotAtStation',shipOption:'STD',state:'AT_STATION',edd:'2026-11-04',dotDispatched:false,dotAtStation:true},
 {stationCode:'KLZA',trackingId:'3',bucket:'BoardDelivered',shipOption:'EXP'},
 {stationCode:'KLZA',trackingId:'4',bucket:'BoardDelivered',shipOption:'in-swa-2'}];
 const premium=mapBoardTidExportRows(rows,'premium');assert.equal(premium.length,1);assert.equal(premium[0].status,'Failed');assert.equal(premium[0].currentState,'AT_STATION');
 assert.equal(matchesDotMetric(premium[0],'Dispatched'),true);assert.equal(matchesDotMetric(premium[0],'At station'),true);assert.equal(matchesDotMetric(premium[0],'Delivered'),false);
 assert.equal(mapBoardTidExportRows(rows,'standard').length,1);assert.equal(mapBoardTidExportRows(rows,'swa').length,1);
 const board=normalizeBoard({daDsrSwa:[{driverId:'A',driverName:'Associate',total:1,delivered:1}]});assert.equal(daDsrForView(board,'swa')[0].driverName,'Associate');
});
test('Overall DOT merges Premium + Standard DA rows by driver',()=>{
 const board=normalizeBoard({
  daDsrPremium:[{driverId:'D1',driverName:'Ravi',total:4,delivered:2,failed:1,rejected:0,oor:1,other:0,dsrPct:50}],
  daDsrStandard:[{driverId:'D1',driverName:'Ravi',total:6,delivered:3,failed:0,rejected:1,oor:2,other:0,dsrPct:50},{driverId:'D2',driverName:'Anu',total:2,delivered:2,failed:0,rejected:0,oor:0,other:0,dsrPct:100}],
 });
 const rows=daDsrForView(board,'dot').sort((a,b)=>a.driverId.localeCompare(b.driverId));
 assert.equal(rows.length,2);
 assert.equal(rows[0].driverId,'D1');assert.equal(rows[0].total,10);assert.equal(rows[0].delivered,5);assert.equal(rows[0].failed,1);assert.equal(rows[0].rejected,1);assert.equal(rows[0].oor,3);assert.equal(rows[0].dsrPct,50);
 assert.equal(rows[1].driverId,'D2');assert.equal(rows[1].total,2);assert.equal(rows[1].dsrPct,100);
 assert.equal(daDsrForView(board,'premium').length,1);
 assert.equal(daDsrForView(board,'standard').length,2);
});
