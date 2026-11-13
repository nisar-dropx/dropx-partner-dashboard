import test from 'node:test';import assert from 'node:assert/strict';
import {highValueException,highValueHistoryRows} from './lm-high-value-exceptions.ts';
const now=Date.parse('2026-11-14T23:00:00+05:30');
const row={stationCode:'JUGF',trackingId:'T1',shipmentValue:5000,state:'HELD',driverId:'',driverName:'',edd:'2026-11-20'};
const scan=(state,day,time='10:00')=>({state,time:`2026-11-${day}T${time}:00+05:30`,source:'JUGF',destination:'CUSTOMER_ADDRESS'});
const evidence=(history,state='HELD')=>({stationCode:'JUGF',trackingId:'T1',state,history,checkedAt:new Date(now).toISOString(),updatedAt:null,product:''});
test('inclusive 5000, age 3 days, future EDD and fresh dispatch do not reset age',()=>{
 const e=evidence([scan('INDUCTED',11),scan('IN_TRANSIT',14)],'IN_TRANSIT');
 assert.equal(highValueException(row,e,now).ageDays,3);
 assert.equal(highValueException({...row,shipmentValue:4999.99},e,now),null);
});
test('three distinct activity days qualify; duplicate scans do not inflate',()=>{
 const h=[scan('DELIVERY_FAILED',12),scan('DELIVERY_FAILED',13),scan('IN_TRANSIT',14)];
 assert.equal(highValueException(row,evidence(h),now).activityDays,3);
 assert.equal(highValueException(row,evidence([h[0],h[0],h[1]]),now),null);
});
test('rejected / ready for return / out on road stay open; delivered and confirmed FC return clear',()=>{
 for(const state of ['DELIVERY_REJECTED','READY_FOR_FC_RETURN','IN_TRANSIT_TO_CUSTOMER'])assert.ok(highValueException(row,evidence([scan('INDUCTED',10)],state),now));
 for(const state of ['DELIVERED','CASH_AT_STATION','RETURNED_TO_FC'])assert.equal(highValueException(row,evidence([scan('INDUCTED',10)],state),now),null);
});
test('unknown history, foreign station, invalid induction and ambiguous transit cannot establish three days',()=>{
 assert.equal(highValueException(row,evidence([]),now),null);
 assert.equal(highValueException(row,{...evidence([scan('INDUCTED',10)]),stationCode:'JUGD'},now),null);
 assert.equal(highValueException(row,evidence([{...scan('INDUCTED',10),source:'OTHER'}]),now),null);
 assert.equal(highValueException(row,evidence([{...scan('INDUCTED',10),reasonCode:'INDUCT_SHIPMENT_STATUS_CANNOT_BE_INDUCTED'}]),now),null);
 assert.equal(highValueException(row,evidence([12,13,14].map(d=>({...scan('IN_TRANSIT',d),destination:null}))),now),null);
});
test('verified return connection closes; a stale historical return cannot close later attempts',()=>{
 const h=[scan('INDUCTED',10),{...scan('DEPARTED',14),destination:'FULFILLMENT_CENTER'}];
 assert.equal(highValueException(row,evidence(h,'DEPARTED'),now),null);
 assert.ok(highValueException(row,evidence([...h,scan('DELIVERY_FAILED',14,'20:00')],'DELIVERY_FAILED'),now));
});
test('image history retains three separate attempt days despite many same-day scans',()=>{
 const rows=highValueHistoryRows([scan('DELIVERY_FAILED',11),scan('DELIVERY_FAILED',12),scan('DELIVERY_FAILED',13),...['10:10','10:11','10:12','10:13','10:14'].map(t=>scan('RECEIVED',14,t)),scan('IN_TRANSIT',14,'11:00')]);
 assert.deepEqual(rows.filter(h=>h.state==='DELIVERY_FAILED').map(h=>h.time.slice(8,10)),['13','12']);
 assert.equal(rows[0].state,'IN_TRANSIT');
 const attempted=highValueHistoryRows([scan('DELIVERY_FAILED',11),scan('DELIVERY_FAILED',12),scan('DELIVERY_FAILED',13),...['10:10','10:11','10:12','10:13','10:14'].map(t=>scan('RECEIVED',13,t))]);
 assert.equal(attempted.filter(h=>h.state==='DELIVERY_FAILED').length,3);
});
