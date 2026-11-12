import test from 'node:test';import assert from 'node:assert/strict';import {pendingHighValue,highValueStatus,highValueSummary} from './lm-high-value.ts';
test('held stock has no EDD exclusion; attempted pending; delivered/rejected closed; one parcel sufficient',()=>{
 const make=(trackingId,state,edd='2026-11-20')=>({stationCode:'KTUO',trackingId,state,edd,shipmentValue:7000,driverId:'',driverName:''});
 const rows=pendingHighValue([make('a','HOLD_FOR_REDELIVERY'),make('b','DELIVERY_ATTEMPTED'),make('c','DELIVERED'),make('d','DELIVERY_REJECTED')]);
 assert.equal(rows.length,2);assert.equal(highValueSummary(rows)[0][6],2);assert.equal(pendingHighValue([make('a','HELD')]).length,1);
 assert.equal(highValueStatus('IN_TRANSIT'),'Check status');assert.equal(highValueStatus('IN_TRANSIT_TO_CUSTOMER'),'Out on road');
});

test('new default includes 3000.01 and excludes exactly 3000',()=>{
 const make=(trackingId,shipmentValue)=>({stationCode:'KTUO',trackingId,state:'HELD',edd:'2026-11-20',shipmentValue,driverId:'',driverName:''});
 assert.deepEqual(pendingHighValue([make('a',3000),make('b',3000.01),make('c',4999)]).map(r=>r.trackingId),['c','b']);
});
