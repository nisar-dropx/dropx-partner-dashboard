import test from 'node:test';
import assert from 'node:assert/strict';
import {filterProviderMappingLookup} from './provider-mapping-lookup.ts';
test('identity-only links are discoverable by either ID without a payment history',()=>{
 const entry={key:'identity',stationId:'station',stationLabel:'Example station',workforceId:'worker',dropxId:'DF-test',fullName:'Example Associate',providerMemberId:'200001',providerMemberName:'Example Associate',profileLocationLabel:'Example station',history:[]};
 for(const query of ['DF-test','200001'])assert.deepEqual(filterProviderMappingLookup([entry],query,'station',false),[entry]);
 assert.deepEqual(filterProviderMappingLookup([entry],'200001','other-station',true),[]);
});
