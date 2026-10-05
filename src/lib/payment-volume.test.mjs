import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedInbound, volumeBaseline, shiftDay, dateKey, shipmentSize, highVolumeContext } from './payment-volume.ts';
import { inboundServingStation } from './inbound-serving-station.ts';

test('BAU uses only four prior matching weekdays and never substitutes missing days with zero', () => {
  const date = '2026-10-05';
  const days = [7,14,21,28].map(n => ({ date: shiftDay(date,-n), inbound: 100, delivered: null, deliverySource: '' }));
  days.push({ date, inbound: 150, delivered: 40, deliverySource: '' });
  assert.deepEqual(volumeBaseline(days,date), { baseline: 100, baselineDays: 4, difference: 50 });
  assert.equal(volumeBaseline(days.slice(1),date).difference,null);
  assert.equal(volumeBaseline(days.map(d=>({...d,inbound:0})),date).difference,null);
});
test('dates are real dates including leap years', () => {
  assert.equal(dateKey('2026-02-30'),false); assert.equal(dateKey('2024-02-29'),true);
  assert.equal(dateKey('2026-2-1'),false); assert.equal(shiftDay('2026-01-01',-1),'2025-12-31');
});
test('only high-volume van deployment requests trigger volume context', () => {
  const answers=[{answer_value:'High Volume',payment_head_questions:{question_text:'Reason of Adhoc Deployment'}},{answer_value:'2026-10-05',payment_head_questions:{question_text:'Deployment Date'}}];
  assert.equal(highVolumeContext('VAN_ADHOC',answers),'2026-10-05');
  assert.equal(highVolumeContext('ADHOC_DA',answers),null);
  assert.equal(highVolumeContext('VAN_ADHOC',answers.slice(0,1)),null);
});
test('small requires complete measurements; any exceeded limit means van-needed', () => {
  const rule={maxLengthCm:46,maxWidthCm:36,maxHeightCm:20,maxWeightKg:5,dimensionalDivisor:5000,maxDimensionalWeightKg:5};
  const small={length_cm:20,width_cm:20,height_cm:10,actual_weight_kg:5,cubic_volume_cm3:4000};
  assert.equal(shipmentSize(small,rule),'small');
  assert.equal(shipmentSize({...small,actual_weight_kg:5.1},rule),'bulky');
  assert.equal(shipmentSize({...small,length_cm:47},rule),'bulky');
  assert.equal(shipmentSize({...small,cubic_volume_cm3:26000},rule),'bulky');
  assert.equal(shipmentSize({...small,actual_weight_kg:null},rule),'unknown');
  assert.equal(shipmentSize({...small,actual_weight_kg:null,length_cm:47},rule),'bulky');
  assert.equal(shipmentSize(small,null),'unknown');
});
test('CP-node destinations never collapse into their receiving hub', () => {
  assert.equal(inboundServingStation({'Station':'NLRE','Destination Station':'NLRK'},'NLRE').stationCode,'NLRK');
  assert.equal(inboundServingStation({'Station':'JGBA','Delivery Station':'RPRN'},'JGBA').stationCode,'RPRN');
  assert.equal(inboundServingStation({'Station':'JGBA'},'JGBA').stationCode,'JGBA');
  assert.equal(inboundServingStation({},'NLRE').explicit,false);
  assert.equal(inboundServingStation({'Destination Station':'UNKNOWN'},'NLRE').stationCode,'UNKNOWN');
});

test('historical hub totals cannot become verified inbound or BAU', () => {
 const row = (destination, count=1) => ({package_count: count,raw_payload: destination ? {serving_station_code:destination} : {}});
 assert.deepEqual(verifiedInbound([row('NLRE',10),row('NLRK',9)],'NLRE'),{inbound:10,unverified:0});
 assert.deepEqual(verifiedInbound([row('JGBA',3),row('RPRN',8)],'JGBA'),{inbound:3,unverified:0});
 assert.deepEqual(verifiedInbound([row('NLRE',10),row(null,9)],'NLRE'),{inbound:null,unverified:9});
 assert.deepEqual(verifiedInbound([],'KOZA'),{inbound:null,unverified:0});
 assert.deepEqual(verifiedInbound([row('NLRK')],'NLRE'),{inbound:0,unverified:0});
 const date='2026-10-06';
 const days=[7,14,21,28].map(n=>({date:shiftDay(date,-n),inbound:verifiedInbound([row(null,100)],'NLRE').inbound,delivered:20,deliverySource:''}));
 assert.equal(volumeBaseline(days,date).baseline,null);
});

// Single-station receiving totals remain available; mixed CP hubs require explicit destinations.
test('normal stations count dock packages while mixed hubs withhold ambiguous routes', async () => {
 const {groupedInbound}=await import('./payment-volume.ts');
 const row={tracking_id:'one',station_code:'QLDA',snapshot_at:'2026-10-06',package_count:1,raw_payload:{}};
 assert.equal(groupedInbound([row],['QLDA'],false).inbound,1);
 assert.equal(groupedInbound([row],['NLRE'],true).inbound,null);
 assert.equal(groupedInbound([row,{...row}],['KGQA','KGQC'],false).inbound,1);
 assert.equal(groupedInbound([{...row,raw_payload:{serving_station_code:'NLRK'}}],['NLRE'],true).inbound,0);
});
