import test from 'node:test';import assert from 'node:assert/strict';import {lastDeliveryStop} from './lm-cod-last-stop.ts';
const day='2026-11-13',now=Date.parse(day+'T23:59:00+05:30');
const task=(state,time,extra={})=>({taskState:state,actualExecutionTime:Date.parse(day+'T'+time+':00+05:30')/1000,taskType:'DROP_OFF',executionGeocode:{latitude:21,longitude:84},...extra});
const payload=tasks=>({itineraryDetails:{transporterId:'DA',stops:[{tasks}]}});
test('rejection is a last delivery outcome; later customer-return drop off is excluded',()=>{
 const result=lastDeliveryStop(payload([task('DELIVERED','17:00'),task('REJECTED','18:00'),task('DELIVERED','21:00',{customerReturnTaskFlag:true})]),'DA',day,now);
 assert.equal(result.at,Date.parse(day+'T18:00:00+05:30'));
});
test('another associate and pickup tasks never move the last-stop estimate',()=>{
 assert.equal(lastDeliveryStop(payload([task('DELIVERED','20:00',{domainMap:{deviceOperator:'OTHER'}}),task('PICKED_UP','21:00',{taskType:'PICK_UP'})]),'DA',day,now),null);
});
