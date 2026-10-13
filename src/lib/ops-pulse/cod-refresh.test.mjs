import test from 'node:test';
import assert from 'node:assert/strict';
import {codRefreshDue} from './cod-refresh.ts';
const start=Date.parse('2026-10-13T10:00:00Z');
const at=minutes=>new Date(start+minutes*60000);
const snapshot={fetchedAt:at(0).toISOString(),...Object.fromEntries(['reconciliation','prepareDeposit','remittances'].map(key=>[key,{state:'ok',checkedAt:at(0).toISOString(),data:{}}]))};
test('station refresh interval drives automatic refresh independently of validation retry gap',()=>{
 const row={snapshot,lastAttemptAt:start};
 assert.equal(codRefreshDue(row,15,at(14)),false);
 assert.equal(codRefreshDue(row,15,at(15)),true);
 assert.equal(codRefreshDue(row,5,at(5)),true);
 assert.equal(codRefreshDue({...row,loading:true},5,at(20)),false);
 assert.equal(codRefreshDue(undefined,15,at(30)),false);
});
test('failed and partial reads back off, including when an old snapshot remains visible',()=>{
 const row={snapshot,lastAttemptAt:at(20).getTime(),error:'Offline'};
 assert.equal(codRefreshDue(row,15,at(24)),false);
 assert.equal(codRefreshDue(row,15,at(25)),true);
 const partial={...snapshot,prepareDeposit:{state:'unavailable',checkedAt:at(20).toISOString(),data:null}};
 assert.equal(codRefreshDue({snapshot:partial,lastAttemptAt:at(20).getTime()},15,at(24)),false);
 assert.equal(codRefreshDue({snapshot:partial,lastAttemptAt:at(20).getTime()},15,at(25)),true);
});
test('cached source age is respected without immediately duplicating initial calls',()=>{
 const row={snapshot,lastAttemptAt:at(14).getTime()};
 assert.equal(codRefreshDue(row,15,at(14.5)),false);
 assert.equal(codRefreshDue(row,15,at(15)),true);
});
test('invalid or absent master freshness settings use a bounded 15 minute refresh',()=>{
 for(const setting of [null,undefined,0,NaN,1000]) {
  assert.equal(codRefreshDue({snapshot,lastAttemptAt:start},setting,at(14)),false);
  assert.equal(codRefreshDue({snapshot,lastAttemptAt:start},setting,at(15)),true);
 }
});
