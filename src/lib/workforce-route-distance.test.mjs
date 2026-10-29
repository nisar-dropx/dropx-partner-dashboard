import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeFuelForDay,kilometreRate,rateCardUnit} from './workforce-route-distance.ts';
import {ownRouteFuel} from '../../apps/connect/src/lib/own-route-fuel.ts';
const input={workforceId:'w',stationId:'s',mappingId:'m',date:'2026-10-12',rate:3,hasActivity:true};
const row={id:'route',workforce_id:'w',station_id:'s',mapping_id:'m',work_date:input.date,status:'ready',distance_km:84.6,departure_km:4,delivery_km:76.6,return_km:4,calculated_at:'2026-10-13T00:00:00Z'};
const context=()=>({enabledFrom:'2026-10-01',rows:[row],manual:[],rateOverrides:[]});
test('uses date-mapped rate and exposes the exact route used for pay',()=>{const f=routeFuelForDay(context(),input);assert.equal(f.amount,253.8);assert.equal(f.routeId,'route');assert.equal(routeFuelForDay(context(),{...input,rate:2.5}).amount,211.5)});
test('disabled and historic dates retain the old path',()=>{assert.equal(routeFuelForDay({...context(),enabledFrom:null},input),null);assert.equal(routeFuelForDay(context(),{...input,date:'2026-09-30'}),null)});
test('missing route on an activity day is pending, off day does not invent zero',()=>{const c={...context(),rows:[]};assert.equal(routeFuelForDay(c,input).amount,null);assert.equal(routeFuelForDay(c,{...input,hasActivity:false}),null)});
test('excluded and scan-mismatch days pay no fuel (like absent) and do not block payroll as pending',()=>{
  for (const reason of ['route_excluded','scan_excluded','scan_date_mismatch','route_needs_review','scan_location_missing']) {
    const c={...context(),rows:[{...row,status:'pending',reason,distance_km:null}]};
    assert.equal(routeFuelForDay(c,input),null);
  }
});
test('manual approved units including zero take precedence once',()=>{const c=context();c.manual=[{workforce_id:'w',station_id:'s',work_date:input.date,field_code_snapshot:'KM_RUN',units:0}];const f=routeFuelForDay(c,input);assert.equal(f.amount,0);assert.equal(f.source,'manual');assert.equal(f.routeId,null)});
test('date-specific rate override is applied and conflicting units fail closed',()=>{const c=context();c.rateOverrides=[{workforce_id:'w',station_id:'s',field_code_snapshot:'KM_RUN',effective_from:input.date,effective_to:input.date,input_value:4}];assert.equal(routeFuelForDay(c,input).amount,338.4);c.rows.push({...row,id:'duplicate'});assert.throws(()=>routeFuelForDay(c,input),/Conflicting/)});
test('wrong worker/station/mapping does not borrow another route',()=>{assert.equal(routeFuelForDay(context(),{...input,workforceId:'other'}).status,'pending');assert.equal(routeFuelForDay(context(),{...input,stationId:'other'}).status,'pending');assert.equal(routeFuelForDay(context(),{...input,mappingId:'other'}).reason,'mapping_changed')});
test('own route appears once per date and overlapping mappings are rejected',()=>{const m={id:'m',station_id:'s',effective_from:'2026-10-01',payment_values:{KM_RUN:3}};const a=[{mappingId:'m',date:input.date}];assert.equal(ownRouteFuel(context(),'w',[m],a).length,1);assert.throws(()=>ownRouteFuel(context(),'w',[m,{...m,id:'m2'}],[...a,{mappingId:'m2',date:input.date}]),/Overlapping/)});
test('rate card uses explicit units, absent kilometre component is not invented',()=>{assert.equal(kilometreRate({payment_values:{DELIVERY:14}}),null);assert.equal(rateCardUnit({calculation_type:'fixed_monthly'},'SALARY'),'per month');assert.equal(rateCardUnit({},'KM_RUN'),'per km')});
