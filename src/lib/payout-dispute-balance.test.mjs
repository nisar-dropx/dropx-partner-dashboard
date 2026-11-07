import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lossDisputeReduction,validateLossBalance,validateBulkDisputeSelection} from './payout-dispute-balance.ts';
const plan={items:[{selector:'deduction',recovery_key:'2026-09|TID|workforce:person',current_value:1000,proposed_value:500}]};
test('Finance explicitly chooses treatment and reason for only the reduced loss',()=>{
 assert.equal(lossDisputeReduction(plan),500);
 for(const treatment of ['outstanding','write_off'])assert.deepEqual(validateLossBalance(plan,treatment,'Checked the disputed assignment.'),{treatment,reason:'Checked the disputed assignment.'});
 assert.throws(()=>validateLossBalance(plan,'','Checked the disputed assignment.'));
 assert.throws(()=>validateLossBalance(plan,'write_off',''));
 assert.equal(validateLossBalance({items:[{selector:'deduction',code:'TDS',current_value:100,proposed_value:0}]},'',''),null);
});
test('Bulk approval rejects duplicate, unchecked, malformed and oversized requests',()=>{
 const row={id:'00000000-0000-0000-0000-000000000001',version:3,digest:'a'.repeat(64),reviewed:true};
 assert.equal(validateBulkDisputeSelection([row]).length,1);
 for(const rows of [[],[row,row],[{...row,reviewed:false}],[{...row,id:'-'.repeat(36)}],[{...row,version:0}],Array(11).fill(row)])assert.throws(()=>validateBulkDisputeSelection(rows));
});
