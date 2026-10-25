import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lossFilterValues, lossFilterValue, lossFilterMatches, sortLossRows} from '../src/lib/ops-pulse/loss-list-controls.ts';
test('multi-select round trips reasons with commas and preserves old deep links',()=>{
 const selected=['Damaged, customer return','Lost'];
 assert.deepEqual(lossFilterValues(lossFilterValue(selected)), selected);
 assert.deepEqual(lossFilterValues('ERSE'),['ERSE']);
 assert.deepEqual(lossFilterValues(['ERSE','SPBE','ERSE']),['ERSE','SPBE']);
 assert.deepEqual(lossFilterValues('[null,4,"ERSE"]'),['ERSE']);
 assert.ok(lossFilterMatches(lossFilterValue(selected),'Lost'));
 assert.ok(!lossFilterMatches(lossFilterValue(selected),'Other'));
});
test('value/station/count sorts do not mutate source and compare numeric values',()=>{
 const rows=[{station_code:'SPBE',amount:8200,count:1},{station_code:'ERSE',amount:27999,count:4}];
 assert.equal(sortLossRows(rows)[0].station_code,'ERSE');
 assert.equal(sortLossRows(rows,'value_asc')[0].station_code,'SPBE');
 assert.equal(sortLossRows(rows,'station_asc')[0].station_code,'ERSE');
 assert.equal(sortLossRows(rows,'station_desc')[0].station_code,'SPBE');
 assert.equal(sortLossRows(rows,'cases_desc')[0].count,4);
 assert.equal(rows[0].station_code,'SPBE');
});
