import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDistanceAssociates } from './distance-associates.ts';
const row = { workforceId: 'w1', name: 'Same Name', station: 'KTUB', amazonId: 'a1', dropxId: 'd1', date: '2026-10-12', status: 'ready', method: 'amazon_gps', km: 10, fuel: 30 };
test('groups by stable associate identity across dates and stations, not names', () => {
 const result = summarizeDistanceAssociates([row, {...row, date:'2026-10-13',station:'TLPB', amazonId:'a2', method:'manual', fuel:40}, {...row,workforceId:'w2'}]);
 assert.equal(result.length,2);
 const a=result.find(r=>r.id==='w1');
 assert.equal(a.km,20); assert.equal(a.fuel,70); assert.equal(a.dates,2);
 assert.deepEqual(a.stations,['TLPB','KTUB']); assert.deepEqual(a.amazonIds,['a2','a1']);
 assert.equal(a.days[0].date,'2026-10-13'); assert.equal(a.sources.length,2);
});
test('pending amounts never inflate totals or masquerade as zero', () => {
 const pending={...row,date:'2026-10-13',status:'pending',method:'pending',km:999,fuel:999};
 const [a]=summarizeDistanceAssociates([row,pending]);
 assert.equal(a.pending,1); assert.equal(a.ready,1); assert.equal(a.km,10); assert.equal(a.fuel,30);
 const [b]=summarizeDistanceAssociates([pending]); assert.equal(b.km,null); assert.equal(b.fuel,null);
 const [zero]=summarizeDistanceAssociates([{...row,km:0,fuel:0}]); assert.equal(zero.km,0);
});
test('a filtered subset stays a subset and unique dates differ from station-days', () => {
 assert.deepEqual(summarizeDistanceAssociates([]),[]);
 const [a]=summarizeDistanceAssociates([row,{...row,station:'TLPB'}]);
 assert.equal(a.dates,1); assert.equal(a.days.length,2);
 const [b]=summarizeDistanceAssociates([{...row,status:'pending',method:'pending',km:null,fuel:null}]);
 assert.equal(b.ready,0); assert.equal(b.days.length,1);
});
