import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceColour,formatBoardPerformance} from './board-report-format.ts';
import {rtsTotals,rtsTable} from './rts-report.ts';
test('target colours distinguish below, near and meeting target; missing target is neutral',()=>{
 assert.equal(performanceColour(77,94).color,'#991b1b');
 assert.equal(performanceColour(80,94).color,'#92400e');
 assert.equal(performanceColour(89.99,94).color,'#92400e');
 assert.equal(performanceColour(90,94).color,'#166534');
 assert.equal(performanceColour(93.99,94).color,'#166534');
 assert.equal(performanceColour(94,94).color,'#ffffff');
 assert.equal(performanceColour(95.49,95.5).color,'#166534');
 assert.equal(performanceColour(100).color,'#334155');
 const t={title:'DSR',subtitle:'',headers:['DSR%'],rows:[[{text:'84.57%'}]]};
 assert.equal(formatBoardPerformance(t,94).rows[0][0].text,'84.57%');
});
test('overall DOT can colour each station against its shipment mix',()=>{
 const t={title:'DOT',subtitle:'',headers:['Station','DOT%'],rows:[[{text:'A'},{text:'94.00%'}],[{text:'B'},{text:'94.00%'}]]};
 const result=formatBoardPerformance(t,94,row=>row[0].text==='A'?95.5:93.5);
 assert.equal(result.rows[0][1].color,'#166534');assert.equal(result.rows[1][1].color,'#ffffff');
});
test('RTS totals preserve missing versus zero value and associate shipment detail',()=>{
 const rows=[{stationCode:'KLZA',trackingId:'001234567890',driverId:'A',driverName:'Associate',status:'Return pending',rtsValue:1912,rtsAgeDays:2},{stationCode:'KLZA',trackingId:'2',driverId:'A',status:'Cash / closure pending',rtsValue:0},{stationCode:'KTUR',trackingId:'3',driverId:'B',status:'Date verification needed',rtsValue:null}];
 assert.deepEqual(rtsTotals(rows),{count:3,value:1912,missing:1,oldest:2,cash:1});
 assert.equal(rtsTable(rows,'station').rows.length,3);
 assert.equal(rtsTable(rows,'associate').rows[0][3].text,'2');
 const table=rtsTable(rows,'shipment');assert.equal(table.rows[0][2].text,'001234567890');assert.equal(table.rows[2][4].text,'—');assert.equal(table.rows[1][4].text,'0.00');
});
