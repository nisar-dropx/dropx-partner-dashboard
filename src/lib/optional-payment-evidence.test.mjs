import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { optionalPaymentEvidence, EVIDENCE_UNAVAILABLE } from './optional-payment-evidence.ts';

test('optional evidence returns a successful response without changing it', async () => {
 const data={days:[],vehicles:[]};
 assert.deepEqual(await optionalPaymentEvidence(async()=>data,20),{data,error:''});
});
test('unavailable and throwing evidence become an advisory result', async () => {
 for (const loader of [()=>{throw Error('database down')},async()=>{throw Error('network down')}]) {
  assert.deepEqual(await optionalPaymentEvidence(loader,20),{data:null,error:EVIDENCE_UNAVAILABLE});
 }
});
test('a hanging evidence source has a bounded deadline and late failures are handled', async () => {
 assert.deepEqual(await optionalPaymentEvidence(()=>new Promise(()=>{}),5),{data:null,error:EVIDENCE_UNAVAILABLE});
 assert.equal((await optionalPaymentEvidence(()=>new Promise((_,reject)=>setTimeout(()=>reject(Error('late')),15)),5)).data,null);
 await new Promise(resolve=>setTimeout(resolve,20));
});
test('request and approval mutations do not depend on advisory volume evidence', () => {
 for(const path of ['../app/payments/requests/actions.ts','../app/payments/approvals/actions.ts']){
  const source=readFileSync(new URL(path,import.meta.url),'utf8');
  assert.doesNotMatch(source,/loadPaymentVolume|optionalPaymentEvidence|volume-context/);
 }
 const approval=readFileSync(new URL('../app/payments/approvals/page.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(approval,/await loadPaymentVolume/);
 assert.match(approval,/<Suspense[^>]*[\s\S]*?<PaymentApprovalVolume/);
});
