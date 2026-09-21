import assert from 'node:assert/strict';import test from 'node:test';
import {personalPaymentCard} from './personal-payment-card.ts';
import {allocateOwnDailyCards} from './workforce-daily-card.ts';
test('personal terms are opt-in, configured and allocated once per day',()=>{
 assert.equal(personalPaymentCard({payment_values:{MG_PER_DAY:800},pay_type:'MG_PER_DAY'}),null);
 const card=personalPaymentCard({payment_values:{DROPX_PERSONAL_TERMS:1,MG_PER_DAY:800},pay_type:'MG_PER_DAY',effective_from:'2026-02-05'});
 const row={id:'one',work_date:'2026-02-05',total_activity:10,total_delivery:10,c_return:0,mfn:0,mfn_return:0};
 const results=allocateOwnDailyCards([{row,card},{row:{...row,id:'two'},card}]);assert.equal(results.get('one')+results.get('two'),800);
 const variable=personalPaymentCard({payment_values:{DROPX_PERSONAL_TERMS:1,DELIVERY:16,CRETURN:14,SELLER_PICKUP:4,SLLLER_RETURN:3},pay_type:'PER_PACKET',effective_from:'2026-02-20'});
 assert.equal(allocateOwnDailyCards([{row:{...row,work_date:'2026-02-20',total_activity:13,c_return:1,mfn:1,mfn_return:1},card:variable}]).get('one'),181);
 assert.throws(()=>personalPaymentCard({payment_values:{DROPX_PERSONAL_TERMS:1,MG_PER_DAY:-1},pay_type:'MG_PER_DAY'}),/Invalid/);
});
