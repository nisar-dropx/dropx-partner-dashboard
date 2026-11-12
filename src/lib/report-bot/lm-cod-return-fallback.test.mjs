import {test} from 'node:test';
import assert from 'node:assert/strict';
import {directReturnEstimate,DIRECT_ESTIMATE_BASIS} from './lm-cod-return-fallback.ts';
import {evidenceFromSnapshot,pickupReview} from './lm-cod-workflow.ts';
test('offline estimate reports direct distance with conservative allowance',()=>{
 const estimate=directReturnEstimate([12,78],[12.1,78]);assert.equal(estimate.distanceKm,11.1);assert.ok(estimate.travelMinutes>=95);assert.equal(estimate.basis,DIRECT_ESTIMATE_BASIS);
 assert.equal(directReturnEstimate([12,78],[12,78]).travelMinutes,15);
});
test('missing, nonnumeric, zero and implausibly distant coordinates stay unverified',()=>{
 for(const p of [null,[NaN,78],['12',78],[91,78],[0,0],[13,78]])assert.equal(directReturnEstimate(p,[12,78]),null);
});
test('approximate arrival cannot become evidence that cash was due before pickup',()=>{
 const now=Date.parse('2026-11-12T18:00:00+05:30'),stamp=new Date(now).toISOString();
 const data={reconciliation:{state:'ok',checkedAt:stamp,data:{complete:true,drivers:[{id:'DA',name:'Associate',pendingAmount:1000,packages:[{trackingId:'TID',amount:1000}]}]}},prepareDeposit:{state:'ok',checkedAt:stamp,data:{actualAmount:0,sourceScope:'outstanding_history',sourceWindow:{startTime:0}}},remittances:{state:'ok',checkedAt:stamp,data:{complete:true,rows:[]}}};
 const before=evidenceFromSnapshot(data,new Map([['DA',{closed:true,dueAt:now-60000,lastStopAt:now-7200000,basis:DIRECT_ESTIMATE_BASIS}]]));
 assert.equal(before.drivers[0].dueAt,null);
 const after={...before,at:now+60000,remittances:[{id:'bank',code:'AC1',status:'SUBMITTED',actualAmount:5000,updatedAt:now+30000}]};
 assert.deepEqual(pickupReview(before,after,now+30000).lateDas,[]);
});
