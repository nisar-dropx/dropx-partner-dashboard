import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentReference} from './payment-reference.ts';
import {createRoutePreviewCache} from './route-preview-cache.ts';
import {payoutEarningGroups,payoutUnit} from './payout-display.ts';
const component=(code,type,schedule)=>({component_code:code,is_active:true,pay_schedule:schedule,payment_fields:{code,field_type:type,calculation_type:type==='production'?'count_x_rate':schedule==='per_month'?'fixed_monthly':'fixed_daily'}});
const mapping={id:'mapping',station_id:'station',stations:{station_code:'ABC'},status:'active',effective_from:'2026-10-01',effective_to:null,payment_values:{SALARY:17000,DELIVERY:14,KM_RUN:3},payment_methods:{name:'Salary + packages + fuel',payment_method_components:[component('SALARY','fixed','per_month'),component('DELIVERY','production','per_unit'),component('KM_RUN','production','per_unit')]}};
test('reference follows assigned units and effective dated rate changes without calculating pay',()=>{
 const ref=paymentReference('2026-10-13',[mapping,{...mapping,id:'ended',effective_to:'2026-10-12'}],[],[],[{station_id:'station',field_code_snapshot:'KM_RUN',effective_from:'2026-10-10',effective_to:'2026-10-15',input_value:4}]);
 assert.equal(ref.cards.length,1);
 assert.deepEqual(ref.cards[0].lines.map(l=>[l.rate,l.unit]),[[17000,'per month'],[14,'per package'],[4,'per km']]);
 assert.equal(ref.cards[0].lines[2].overrideTo,'2026-10-15');
});
test('an unrelated station override never alters an associate rate; missing component values do not become zero',()=>{
 const ref=paymentReference('2026-10-13',[{...mapping,payment_values:{KM_RUN:3}}],[],[],[{station_id:'elsewhere',field_code_snapshot:'KM_RUN',effective_from:'2026-10-01',effective_to:'2026-10-31',input_value:0}]);
 assert.equal(ref.cards[0].lines.length,1);assert.equal(ref.cards[0].lines[0].rate,3);
});
test('saved route requests deduplicate and invalidate by version; caches stay account-owned',async()=>{
 const cache=createRoutePreviewCache(),other=createRoutePreviewCache();let reads=0;
 const load=async()=>{reads++;return {stops:7}};
 await Promise.all([cache.get('account:a:route:1:v1',load),cache.get('account:a:route:1:v1',load)]);
 await cache.get('account:a:route:1:v1',load);assert.equal(reads,1);
 await cache.get('account:a:route:1:v2',load);await other.get('account:a:route:1:v1',load);assert.equal(reads,3);
});
test('a failed route request remains retryable',async()=>{
 const cache=createRoutePreviewCache();await assert.rejects(cache.get('route',async()=>{throw Error('temporary')}));assert.equal(await cache.get('route',async()=>12),12);
});
test('payouts preserve real package units and salary while keeping zero pay out of totals',()=>{
 const base={rate:14,units:25,amount:350,sortOrder:0};
 const packageLine={...base,code:'DELIVERY',label:'Delivery',basis:'per_unit'};
 const salary={...base,code:'SALARY',label:'Salary',basis:'per_month',amount:17000};
 const fuel={...base,code:'KM_RUN',label:'KM rate',basis:'per_unit',amount:75};
 const groups=payoutEarningGroups([packageLine,salary,fuel,{...packageLine,amount:0}]);
 assert.deepEqual(groups.map(g=>g.title),['Salary & guaranteed pay','Fuel allowance','Activity pay & additions']);
 assert.equal(groups[2].lines[0].units,25);assert.equal(groups.flatMap(g=>g.lines).reduce((n,l)=>n+l.amount,0),17425);
 assert.equal(payoutUnit(packageLine),'package');assert.equal(payoutUnit(salary),'month');assert.equal(payoutUnit(fuel),'km');
});
