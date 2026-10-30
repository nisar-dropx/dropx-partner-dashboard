import assert from 'node:assert/strict';
import test from 'node:test';
import { responseActions } from './loss-response-actions.ts';
const actions=(overrides={})=>responseActions({enabled:true,state:'awaiting_station',canManage:true,stationView:true,readOnly:false,...overrides});
test('station context exposes only evidence even to managers',()=>{
 for(const canManage of [true,false]) {
  for(const state of ['awaiting_station','returned','legacy']) assert.deepEqual(actions({canManage,state}),['response']);
  for(const state of ['awaiting_review','approved','with_vendor','won','lost','cancelled']) assert.deepEqual(actions({canManage,state}),[]);
 }
});
test('management form reviews evidence, never submits or enables/removes',()=>{
 assert.deepEqual(actions({stationView:false}),[]);
 assert.deepEqual(actions({stationView:false,state:'awaiting_review'}),['approve','return']);
 assert.deepEqual(actions({stationView:false,state:'approved'}),['tracking','won','lost']);
 assert.deepEqual(actions({stationView:false,state:'with_vendor'}),['tracking','won','lost']);
 assert.deepEqual(actions({stationView:false,state:'awaiting_review',canManage:false}),[]);
});
test('disabled and read-only states have no actions',()=>{
 for(const stationView of [true,false])for(const state of ['awaiting_station','awaiting_review','approved']) {
  assert.deepEqual(actions({stationView,state,enabled:false}),[]);
  assert.deepEqual(actions({stationView,state,readOnly:true}),[]);
 }
});
