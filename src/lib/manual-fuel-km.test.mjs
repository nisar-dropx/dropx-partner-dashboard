import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFuelForDay } from './workforce-route-distance.ts';
import { ownRouteFuel } from '../../apps/connect/src/lib/own-route-fuel.ts';

const input = { workforceId:'w',stationId:'s',mappingId:'m',date:'2026-10-01',rate:3,hasActivity:true };
const manual = { workforce_id:'w',station_id:'s',work_date:input.date,field_code_snapshot:'KM_RUN',units:200 };
const context = { source:'manual',enabledFrom:'2026-10-01',rows:[{id:'old-map',workforce_id:'w',station_id:'s',mapping_id:'m',work_date:input.date,status:'ready',distance_km:100}],manual:[manual],rateOverrides:[] };
test('manual kilometres replace map kilometres rather than adding them',()=>{
  const fuel=routeFuelForDay(context,input);
  assert.equal(fuel.km,200);assert.equal(fuel.amount,600);
  assert.equal(fuel.routeId,null);assert.equal(fuel.source,'manual');
});
test('maps and attendance never invent kilometres when no manual input exists',()=>{
  assert.equal(routeFuelForDay({...context,manual:[]},input),null);
  assert.equal(routeFuelForDay(context,{...input,date:'2026-10-02'}),null);
});
test('explicit zero, rate overrides and conflicting manual rows are handled',()=>{
  assert.equal(routeFuelForDay({...context,manual:[{...manual,units:0}]},input).amount,0);
  assert.equal(routeFuelForDay({...context,rateOverrides:[{...manual,effective_from:input.date,effective_to:input.date,input_value:4}]},input).amount,800);
  assert.throws(()=>routeFuelForDay({...context,manual:[manual,manual]},input),/Conflicting/);
});
test('One includes a monthly manual input once even without activity on its posting date',()=>{
  const fuel=ownRouteFuel(context,'w',[{id:'m',station_id:'s',effective_from:input.date,payment_values:{KM_RUN:3}}],[]);
  assert.equal(fuel.length,1);assert.equal(fuel[0].amount,600);
});
