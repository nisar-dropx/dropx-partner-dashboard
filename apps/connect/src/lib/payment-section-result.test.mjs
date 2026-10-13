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
test('payments keep auth-scoped reads separate and guard stale earnings',()=>{
 const source=readFileSync(new URL('../components/connect-workforce-payments.tsx',import.meta.url),'utf8');
 assert.match(source,/reconcileOwnProduction\(result.earnings,result.summary\)/);
 assert.match(source,/if\(version!==generation.current\)return/);
 assert.match(source,/result.month!==month/);
 assert.match(source,/earningsAllowed\|\|access.includes\('rate_card'\)/);
 assert.match(source,/payment-reference/);
 assert.doesNotMatch(source,/api\/connect\/workforce-payments/);
 assert.match(source,/createRoutePreviewCache/);
 assert.match(source,/normalizePayoutMonth/);
 const payouts=readFileSync(new URL('../components/associate-payouts.tsx',import.meta.url),'utf8');
 assert.match(payouts,/!response.ok \|\| !Array.isArray\(body.payouts\)/);
 assert.match(payouts,/generation !== loadGeneration.current/);
 assert.match(payouts,/setPayouts\(\[\]\)/);
 assert.match(payouts,/Payout not published yet/);
 assert.match(payouts,/if\s*\(!response.ok\)\s*throw new Error\(body.error\)/);
 assert.match(payouts,/onMonthLockChange\?\.\(loading \|\| busy\)/);
 assert.match(payouts,/payout.payoutSlipAvailable \? <a/);
 const paymentInformation=payouts.slice(payouts.indexOf('<h3>Payment information</h3>'),payouts.indexOf('</section>',payouts.indexOf('<h3>Payment information</h3>')));
 assert.match(paymentInformation,/aria-label="Bank details"/);
 assert.doesNotMatch(paymentInformation,/payout\.(?:dropxId|name|station|providerIds|paymentReference|paymentDate)/);
 const route=readFileSync(new URL('../../app/api/connect/payment-reference/route.ts',import.meta.url),'utf8');
 assert.match(route,/requireConnectAccount/);
 assert.match(route,/eq\('company_id',account.companyId\)/);
 assert.match(route,/eq\('workforce_id',worker.id\)/);
 assert.match(route,/private, no-store/);
 assert.doesNotMatch(route,/cps_shipment_daily|attendance_daily|workforce_route_distances/);
});

test('published revisions, historical bank fields and month reads retain their existing boundaries',()=>{
 const payoutLoader=readFileSync(new URL('./associate-payouts.ts',import.meta.url),'utf8');
 const reviewRoute=readFileSync(new URL('../../app/api/connect/payout-review/route.ts',import.meta.url),'utf8');
 assert.match(payoutLoader,/publication\.publication_kind !== "worksheet"/);
 assert.match(payoutLoader,/payoutSlipAvailable: false/);
 assert.match(payoutLoader,/order\("revision", \{ ascending: false, nullsFirst: false \}\)\.order\("published_at", \{ ascending: false \}\)/);
 assert.match(reviewRoute,/publication\.data\.publication_kind==='worksheet'/);
 assert.match(reviewRoute,/newer payout revision is available/i);
 const detailsRoute=readFileSync(new URL('../../app/api/connect/workforce-payments/route.ts',import.meta.url),'utf8');
 assert.match(detailsRoute,/workforcePaymentReadPeriod\(month, today\)/);
 assert.match(detailsRoute,/hasPaymentMapping: mappings\.length > 0 \|\| direct\.allocations\.length > 0/);
 assert.match(detailsRoute,/mapping: currentMappingPayload/);
 assert.match(payoutLoader,/bankDestinationAvailable: publication\?\.publication_kind !== "worksheet"[\s\S]+Object\.prototype\.hasOwnProperty\.call\(item, "bank_account_no"\)/);
});
