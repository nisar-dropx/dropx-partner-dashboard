import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProviderMappingInsights as build, insightPeriod} from './provider-mapping-insights.ts';
import {directPayForDay} from './direct-workforce-pay.ts';
const day = (date, baseAmount, extra = {}) => ({date, baseAmount, attendanceSource: 'Roster', ...extra});
const pay = (days, extra = {}) => ({id:'mapping', name:'Example', dropxId:'ABC1', paymentMethod:'Monthly fixed / MG', paymentDetailsAvailable:true, status:'Ready for review', dailyBreakdown:days, ...extra});
const shipment = (date, count) => ({work_date:date,total_delivery:count});
const input = {from:'2026-10-01',to:'2026-10-28'};

test('saved daily rate and 548 deliveries across 16 imported days produce transparent CPS', () => {
 const counts=[28,34,37,30,30,48,42,45,37,28,25,27,33,35,42,27];
 const shipments=counts.map((count,index)=>shipment(`2026-10-${index+12}`,count));
 const days=Array.from({length:27},(_,index)=>{
  const date=`2026-10-${String(index+1).padStart(2,'0')}`;
  const count=shipments.find(row=>row.work_date===date)?.total_delivery??0;
  const result=directPayForDay({FIXED_PAY_PER_DAY:1000},[{component_code:'FIXED_PAY_PER_DAY',label:'Fixed pay per day',component_type:'amount',pay_schedule:'per_day',calculation_source:'attendance_eligibility'}],date,null,{dailyDeliveryCount:count});
  return day(date,result.total,{lines:result.lines});
 });
 const result=build({...input,shipments,payRows:[pay(days)]});
 assert.equal(result.deliveries,548);assert.equal(result.cost,16000);assert.equal(result.cps,29.2);
 assert.equal(result.days[0].cps,37.04);
 assert.deepEqual(result.paymentBreakdown,[{label:'Fixed pay per day',schedule:'per_day',rate:1000,count:16,amount:16000}]);
});
test('MTD bounds, historical month and invalid/future months', () => {
 assert.deepEqual(insightPeriod('2026-10','2026-10-28'),{from:'2026-10-01',to:'2026-10-28'});
 assert.deepEqual(insightPeriod('2024-02','2026-10-28'),{from:'2024-02-01',to:'2024-02-29'});
 for(const value of ['2026-13','2026-00','2026-11','bad']) assert.equal(insightPeriod(value,'2026-10-28'),null);
});
test('weighted CPS uses engine costs, includes fixed pay on zero delivery days', () => {
 const result=build({...input,shipments:[shipment('2026-10-01',10),shipment('2026-10-02',30),shipment('2026-10-03',0)],payRows:[pay([day('2026-10-01',500),day('2026-10-02',500),day('2026-10-03',500)])]});
 assert.equal(result.deliveries,40);assert.equal(result.cost,1500);assert.equal(result.cps,37.5);
 assert.equal(result.days[0].cps,null);assert.equal(result.days[1].cps,16.67);
 assert.equal(result.latestReport,'2026-10-03');assert.equal(result.days.length,3);
});
test('late imports and missing days never become zero delivery reports', () => {
 const result=build({...input,shipments:[shipment('2026-10-02',10)],payRows:[pay([day('2026-10-01',500),day('2026-10-02',500),day('2026-10-03',500)])]});
 assert.equal(result.days[1].deliveries,null);assert.equal(result.cost,1000);assert.equal(result.days.length,2);
});
test('missing mapping and configuration failure do not imply free deliveries', () => {
 for(const rows of [[],[pay([day('2026-10-01',0)],{status:'Configuration incomplete'})]]) {
  const result=build({...input,shipments:[shipment('2026-10-01',10)],payRows:rows});
  assert.equal(result.cost,null);assert.equal(result.cps,null);assert.ok(result.costIssue);
 }
 const partial=build({...input,shipments:[shipment('2026-10-01',10),shipment('2026-10-02',10)],payRows:[pay([day('2026-10-02',500)])]});
 assert.equal(partial.cost,null);assert.equal(partial.cps,null);assert.equal(partial.days[0].cost,500);
});
test('paid ad hoc exclusion does not produce a misleading zero CPS', () => {
 const result=build({...input,shipments:[shipment('2026-10-01',20)],payRows:[pay([day('2026-10-01',0,{attendanceSource:'Paid ad hoc · REQ1'})])]});
 assert.equal(result.cps,null);assert.equal(result.days[0].cps,null);assert.match(result.costIssue,/Ad hoc/);
});
test('range attendance has no invented day CPS, monthly weighted CPS remains valid', () => {
 const result=build({...input,shipments:[shipment('2026-10-01',10)],payRows:[pay([day('2026-10-01',1000,{attendanceRange:{quantity:2}})])]});
 assert.equal(result.days[0].cps,null);assert.equal(result.cps,100);
});
test('method changes sum saved segments and Amazon/SWA delivery fallback', () => {
 const result=build({...input,shipments:[{work_date:'2026-10-01',total_delivery:null,amazon_delivery:8,swa_delivery:2},shipment('2026-10-02',20)],payRows:[pay([day('2026-10-01',500)]),pay([day('2026-10-02',600)],{paymentMethod:'Per delivery'})]});
 assert.equal(result.cost,1100);assert.equal(result.cps,36.67);assert.equal(result.methods.length,2);
});
