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
 assert.match(source,/tab === "statements" && earningsAllowed \? <AssociatePayouts[^>]+month=\{month\}/);
 assert.ok(source.indexOf('monthStyles.monthPicker') < source.indexOf('<nav aria-label="Payment section"'));
 assert.match(source,/aria-label="Previous earnings and payout month"/);
 assert.match(source,/aria-label="Next earnings and payout month"/);
 assert.match(source,/aria-live="polite"/);
 assert.match(source,/payoutLocked \|\| \(tab === "earnings" && loading\)/);
 assert.match(source,/new URLSearchParams\(\{ accountId: account\.id, profileType: account\.profileType, month \}\)/);
 assert.match(source,/payload\.month!==month/);
 assert.match(source,/result\.month!==month/);
 const payouts=readFileSync(new URL('../components/associate-payouts.tsx',import.meta.url),'utf8');
 assert.match(payouts,/if\s*\(!response\.ok\)\s*throw new Error\(body\.error\)/);
 assert.match(payouts,/Loading finalized earnings/);
 assert.doesNotMatch(payouts,/Previous payout month|Next payout month/);
 assert.match(payouts,/No finalized earnings published for/);
 assert.match(payouts,/loadError \? null : !payout/);
 assert.match(payouts,/onMonthLockChange\?\.\(loading \|\| busy\)/);
 assert.match(payouts,/generation !== loadGeneration\.current/);
 assert.match(payouts,/setPayouts\(\[\]\)/);
 assert.match(payouts,/item\.station \|\| "Station not recorded"/);
 assert.match(payouts,/payout\.payoutSlipAvailable \? <a/);
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
 assert.match(source,/tab === "rate-card" && rateCardAllowed && data && !loading && !error/);
 assert.match(source,/!hasCurrentMap \? <section/);
 const monthCss=readFileSync(new URL('../components/payout-month-control.module.css',import.meta.url),'utf8');
 const paymentCss=readFileSync(new URL('../components/connect-workforce-payments.module.css',import.meta.url),'utf8');
 assert.match(monthCss,/@media \(max-width: 600px\)[\s\S]+\.monthPicker \{[\s\S]+flex: 0 0 auto/);
 assert.match(paymentCss,/\.headingRow > :global\(\.dx-page-intro\) \{\s*margin: 0/);
 assert.match(source,/setError\(details.error\);setEstimateError\(estimate.error\)/);
 assert.match(source,/if\(version!==generation.current\)return;/);
 assert.match(source,/setEstimateError\(''\);setData\(null\);setCalculated\(null\)/);
 assert.match(source,/normalizePayoutMonth\(searchParams\.get\("payoutMonth"\)\)/);
 assert.match(source,/searchParams\.get\("tab"\) === "payouts" && earningsAllowed/);
 assert.match(source,/useState\(linkedPayoutMonth \?\? currentPayoutMonth\(\)\)/);
 assert.match(payoutLoader,/bankDestinationAvailable: publication\?\.publication_kind !== "worksheet"[\s\S]+Object\.prototype\.hasOwnProperty\.call\(item, "bank_account_no"\)/);
 const paymentInformationStart=payouts.indexOf('<h3>Payment information</h3>');
 const paymentInformationEnd=payouts.indexOf('</section>',paymentInformationStart);
 const paymentInformation=payouts.slice(paymentInformationStart,paymentInformationEnd);
 assert.match(paymentInformation,/aria-label="Bank details"/);
 assert.match(paymentInformation,/Bank account/);
 assert.match(paymentInformation,/IFSC/);
 assert.doesNotMatch(paymentInformation,/payout\.(?:dropxId|name|station|providerIds|paymentReference|paymentDate)/);
});
