import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {paymentSectionResult} from './payment-section-result.ts';
test('failed estimate cannot discard independently loaded statements',async()=>{
 const [details,estimate]=await Promise.all([paymentSectionResult(async()=>({statements:[{id:'approved'}]}),'details failed'),paymentSectionResult(async()=>{throw Error('Estimate reconciliation failed');},'estimate failed')]);
 assert.deepEqual(details.data.statements,[{id:'approved'}]);assert.equal(details.error,'');assert.equal(estimate.data,null);assert.match(estimate.error,/reconciliation/);
});
test('network and parse failures remain explicit, never healthy empty sections',async()=>{
 for(const failure of [Error('Network unavailable'),new SyntaxError('Invalid JSON'),null]){
  const result=await paymentSectionResult(async()=>{throw failure;},'Unable to load');
  assert.equal(result.data,null);assert.equal(result.error,failure?.message??'Unable to load');
 }
});
test('a retry returns fresh success without carrying old error',async()=>{
 let failed=true;const load=()=>paymentSectionResult(async()=>{if(failed)throw Error('Unavailable');return {net:25};},'failed');
 assert.equal((await load()).data,null);failed=false;assert.deepEqual(await load(),{data:{net:25},error:''});
});
test('optional estimate can be skipped without creating a failure',async()=>{
 assert.deepEqual(await paymentSectionResult(async()=>null,'failed'),{data:null,error:''});
});
test('UI gates estimates on reconciled data, independently retains document tabs and stale-response guard',()=>{
 const source=readFileSync(new URL('../components/connect-workforce-payments.tsx',import.meta.url),'utf8');
 assert.match(source,/tab === "earnings" && earningsAllowed && data && calculated && !loading && !visibleError/);
 assert.match(source,/tab === "statements" && earningsAllowed && data && !loading && !error/);
 assert.match(source,/tab === "rate-card" && rateCardAllowed && data && !loading && !error/);
 assert.match(source,/setError\(details.error\);setEstimateError\(estimate.error\)/);
 assert.match(source,/if\(version!==generation.current\)return;/);
 assert.match(source,/setEstimateError\(''\);setData\(null\);setCalculated\(null\)/);
});
