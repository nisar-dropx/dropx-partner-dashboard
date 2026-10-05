import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dimensionalWeight, positiveMeasurement, shipmentPincodeBreakup, shipmentDestinationAllowed } from './payment-shipment-evidence.ts';
import { parsePaymentTrackingIds } from './payment-shipment-count.ts';

test('tracking parsing keeps carrier IDs intact and deduplicates paste/scan separators', () => {
 assert.deepEqual(parsePaymentTrackingIds('000123\tAB-456,000123;T002|T003\r\nT004'), ['000123','AB-456','T002','T003','T004']);
 assert.deepEqual(parsePaymentTrackingIds('12345678901234567890'), ['12345678901234567890']);
 assert.deepEqual(parsePaymentTrackingIds(' ;, \n'), []);
});
test('volumetric weight uses configured divisor and refuses missing/invalid measurements', () => {
 assert.equal(dimensionalWeight(50,40,30,null,5000),12);
 assert.equal(dimensionalWeight(50,40,30,null,6000),10);
 assert.equal(dimensionalWeight(null,40,30,60000,5000),12);
 assert.equal(dimensionalWeight(50,40,30,null,null),null);
 assert.equal(dimensionalWeight(null,40,30,null,5000),null);
 for(const n of [0,-1,NaN,Infinity,'',null]) assert.equal(positiveMeasurement(n),null);
});
test('pincode breakup includes missing evidence without losing shipment counts', () => {
 const result=shipmentPincodeBreakup([{pincode:'671121'},{pincode:null},{pincode:'671121'},{pincode:'671123'},{pincode:null}]);
 assert.deepEqual(result,[{pincode:'671121',count:2},{pincode:'Pincode unavailable',count:2},{pincode:'671123',count:1}]);
 assert.equal(result.reduce((sum,row)=>sum+row.count,0),5);
});
test('shipment enrichment is isolated from all payment mutations and loaded only on demand', () => {
 for(const path of ['../app/payments/requests/actions.ts','../app/payments/approvals/actions.ts','../app/payments/expense-request/actions.ts']) {
  const url=new URL(path,import.meta.url);
  let source;try{source=readFileSync(url,'utf8')}catch(e){if(e.code==='ENOENT')continue;throw e}
  assert.doesNotMatch(source,/loadPaymentShipmentEvidence|shipment-evidence|optionalPaymentEvidence/);
 }
 const client=readFileSync(new URL('../components/payment-approval-shipments.tsx',import.meta.url),'utf8');
 assert.match(client,/onToggle/);assert.match(client,/currentTarget.open/);assert.match(client,/optionalPaymentEvidence/);assert.match(client,/AbortController/);
 assert.doesNotMatch(client,/type="submit"|required[= ]/);
 const page=readFileSync(new URL('../app/payments/approvals/page.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(page,/loadPaymentShipmentEvidence/);
});
test('evidence endpoint authorizes saved request and derives IDs server-side', () => {
 const api=readFileSync(new URL('../app/api/payments/shipment-evidence/route.ts',import.meta.url),'utf8');
 const auth=readFileSync(new URL('./payment-evidence-authorization.ts',import.meta.url),'utf8');
 assert.match(auth,/hasPermission\(auth, 'payment_approvals', 'access'\)/);
 assert.match(auth,/canAccessPaymentLocation/);assert.match(auth,/getPaymentApprovalEligibility/);
 assert.match(api,/eq\('company_id', company\)/);assert.match(api,/payment_request_answers/);
 assert.doesNotMatch(api,/searchParams.get\('(?:ids|station|company)'\)/);
});

test('pasted report headings and DA names are excluded from tracking count', () => {
 assert.deepEqual(parsePaymentTrackingIds('Details for Count of Tracking ID - Last Scan By: GOVINDU G PAVAN KUMAR Station: GDRD\n372952359018\n372944216961'),['372952359018','372944216961']);
});

test('shipment detail respects serving-station exclusions and parent XPT scope', () => {
 assert.equal(shipmentDestinationAllowed('NLRK',['NLRE'],true),false);
 assert.equal(shipmentDestinationAllowed(null,['NLRE'],true),false);
 assert.equal(shipmentDestinationAllowed('NLRE',['NLRE'],true),true);
 assert.equal(shipmentDestinationAllowed('KGQC',['KGQA','KGQC'],false),true);
 assert.equal(shipmentDestinationAllowed(null,['KGQA','KGQC'],false),true);
 assert.equal(shipmentDestinationAllowed('RPRN',['JGBA'],true),false);
});
