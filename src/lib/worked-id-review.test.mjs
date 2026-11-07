import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {workedIdCounts,workedIdShareError,workedIdMonth} from './worked-id-review.ts';
test('a shared day requires an explicit owner answer and conserved whole counts',()=>{
 const available=workedIdCounts({total_delivery:10,amazon_delivery:8,swa_delivery:2,delivery_assigned_count:12});
 assert.match(workedIdShareError(available,available,null),/Confirm/);
 assert.equal(workedIdShareError(available,available,false),null);
 assert.match(workedIdShareError(available,{...available,total_delivery:5},false),/all remaining/);
 assert.match(workedIdShareError(available,{...available,total_delivery:11},true),/between/);
 assert.match(workedIdShareError(available,{...available,total_delivery:5.5},true),/whole/);
 assert.match(workedIdShareError(available,{...available,total_delivery:5},true),/Amazon plus SWA/);
 assert.equal(workedIdShareError(available,{...available,total_delivery:5,amazon_delivery:4,swa_delivery:1,delivery_assigned_count:6},true),null);
 assert.deepEqual(workedIdMonth('2026-10'),{from:'2026-10-01',to:'2026-10-31'});
 assert.throws(()=>workedIdMonth('2026-13'),/valid month/);
});
test('all financial readers use reviewed facts; operational evidence remains raw',()=>{
 for(const path of ['src/lib/workforce-payout-loader.ts','apps/connect/app/api/connect/earnings/route.ts','apps/connect/app/api/connect/workforce-payments/route.ts']){
  const source=readFileSync(path,'utf8');
  assert.match(source,/from\("workforce_payout_shipment_facts"\)/,path);
  assert.match(source,/from\("workforce_payout_attendance_facts"\)/,path);
  assert.doesNotMatch(source,/from\(["'](?:cps_shipment_daily|attendance_daily)["']\)/,path);
 }
 assert.match(readFileSync('apps/connect/src/lib/direct-workforce-payment-data.ts','utf8'),/workforce_payout_attendance_facts/);
 assert.match(readFileSync('src/lib/ops-pulse/cps-snapshot.ts','utf8'),/workforce_payout_attendance_facts/);
 assert.match(readFileSync('src/lib/worked-id-review-data.ts','utf8'),/\.from\("attendance_punches"\)/);
});
