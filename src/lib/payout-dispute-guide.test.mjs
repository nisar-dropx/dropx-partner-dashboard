import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGuidedPlan,normalizeGuidedClaim,disputeItems,disputeDays,guidedFields,disputeEvidenceValues} from './payout-dispute-guide.ts';
import {monthlyAttendanceAmountForAggregateUnits} from './workforce-payment-policy.ts';
const policy={effective_from:'2026-09-01',calculation_method:'earned_paid_offs',paid_off_days:4,work_units_per_paid_off:6,cap_at_monthly_amount:true};
let cumulative=0;
const lines=Array.from({length:31},(_,i)=>{const date=`2026-10-${String(i+1).padStart(2,'0')}`,units=[2,4,8,10,28].includes(i+1)?0:1;const p=monthlyAttendanceAmountForAggregateUnits({monthlyAmount:21000,date,attendanceUnits:units,cumulativeAttendanceUnitsBefore:cumulative,policy});cumulative+=units;return {work_date:date,provider_member_id:'2000080009520',source_type:'worksheet',calculation_snapshot:{workDayUnits:units,counts:{totalDelivery:i===9?28:10},paymentLines:[{code:'MG_PER_MONTH',label:'MG Per Month',schedule:'per_month',rate:21000,count:p.amount/21000,amount:p.amount,componentType:'amount'}]}};});
const snapshot={item:{work_days:26,gross_amount:20322.58,deduction_amount:203.23,net_amount:20119.35},lines,worksheet:{production_breakdown:[{code:'MG_PER_MONTH',label:'MG Per Month',schedule:'per_month',rate:21000,count:30/31,amount:20322.58}],deduction_breakdown:[{code:'TDS',label:'TDS',amount:203.23}]}};
const baseSnapshot=snapshot;
const context={policies:[policy],percentageDeductions:[{code:'TDS',rate:1}],checkedAt:'2026-11-07'};
const claim=normalizeGuidedClaim(snapshot,{issue:'attendance',component:'attendance',dates:['2026-10-10'],concern:'I worked but the day is missing'});
function form(value){const f=new FormData();f.set('value_0',value);f.set('checked_value_0','on');return f;}
test('missing attendance day retains mapped delivery evidence',()=>{const d=disputeDays(snapshot).find(d=>d.date==='2026-10-10');assert.equal(d.units,0);assert.equal(d.deliveries,28);assert.deepEqual(d.providerIds,['2000080009520']);});
test('26 to 27 worked days recomputes earned paid offs and TDS, not gross-as-net',()=>{const p=buildGuidedPlan(snapshot,claim,form('1'),context);assert.equal(p.totals.gross_after,21000);assert.equal(p.totals.deductions_after,210);assert.equal(p.totals.net_after,20790);assert.equal(p.expected_delta_paise,67065);assert.equal(p.items[0].date,'2026-10-10');});
test('evidence must be checked for every corrected date',()=>{const f=form('1');f.delete('checked_value_0');assert.throws(()=>buildGuidedPlan(snapshot,claim,f,context),/supporting evidence/);});
test('out-of-period and missing dates cannot be invented',()=>{assert.throws(()=>normalizeGuidedClaim(snapshot,{...claim,dates:['2026-11-01']}),/affected dates/);assert.throws(()=>normalizeGuidedClaim(snapshot,{...claim,dates:[]}),/affected dates/);});
test('deduction selection cannot be changed to an unrelated head',()=>{assert.throws(()=>normalizeGuidedClaim(snapshot,{issue:'deduction',component:'attendance',concern:'Wrong amount'}),/actual payment/);});
test('loss correction identifies its specific recovery key',()=>{const snapshot=structuredClone(baseSnapshot);snapshot.item.deduction_amount+=100;snapshot.item.net_amount-=100;snapshot.worksheet.deduction_breakdown.push({code:'LOSS_RECOVERY',label:'Loss',amount:100,recoveryKey:'2026-09|case|worker'});const item=disputeItems(snapshot).find(i=>i.code==='LOSS_RECOVERY');const c=normalizeGuidedClaim(snapshot,{issue:'deduction',component:item.key,concern:'Already recovered'});const p=buildGuidedPlan(snapshot,c,form('0'),context);assert.equal(p.items[0].recovery_key,'2026-09|case|worker');assert.equal(p.expected_delta_paise,10000);assert.equal(p.totals.gross_after,20322.58);});
test('kilometre correction uses the actual dated rate and adjusts deductions',()=>{const snapshot=structuredClone(baseSnapshot);snapshot.lines[9].calculation_snapshot.paymentLines.push({code:'KM_RUN',label:'Fuel',rate:3,count:20,amount:60,componentType:'production'});snapshot.worksheet.production_breakdown.push({code:'KM_RUN',label:'Fuel',rate:3,count:20,amount:60,componentType:'production'});snapshot.item.gross_amount+=60;snapshot.item.deduction_amount+=.6;snapshot.item.net_amount+=59.4;const item=disputeItems(snapshot).find(i=>i.code==='KM_RUN');const c=normalizeGuidedClaim(snapshot,{issue:'fuel',component:item.key,concern:'Wrong kilometres',dates:['2026-10-10']});const p=buildGuidedPlan(snapshot,c,form('30'),context);assert.equal(p.items[0].current_value,20);assert.equal(p.expected_delta_paise,2970);});
test('missing attendance is not silently converted to absent',()=>{const s=structuredClone(snapshot);delete s.lines[9].calculation_snapshot.workDayUnits;assert.throws(()=>guidedFields(s,claim),/not recorded/);});
test('changed monthly policy fails closed',()=>{assert.throws(()=>buildGuidedPlan(snapshot,claim,form('1'),{...context,policies:[{...policy,calculation_method:'calendar_days'}]}),/differs/);});
test('unchanged value is not a correction',()=>{assert.throws(()=>buildGuidedPlan(snapshot,claim,form('0'),context),/No value changed/);});
test('negative, over-one attendance and invalid numbers are rejected',()=>{for(const v of ['-1','2','0.25','NaN'])assert.throws(()=>buildGuidedPlan(snapshot,claim,form(v),context));});

test('unchanged sync timestamps do not reset review; changed amounts and punch times do',()=>{const a={gross:100,route:{km:10,updatedAt:'old'},delivery:{total:28,updated_at:'old'},in_time:'08:00'};const b={...a,route:{km:10,updatedAt:'new'},delivery:{total:28,updated_at:'new'}};assert.equal(disputeEvidenceValues(a),disputeEvidenceValues(b));assert.notEqual(disputeEvidenceValues(a),disputeEvidenceValues({...b,gross:101}));assert.notEqual(disputeEvidenceValues(a),disputeEvidenceValues({...b,in_time:'10:00'}));});

function dailyCountFixture(){
 const s=structuredClone(baseSnapshot);
 for(const [code,label,count,rate] of [['DELIVERY','Delivery',50,10],['C_RETURN','Customer return',3,5]]){
  const line={code,label,count,rate,amount:count*rate,schedule:'per_unit',componentType:'production'};
  s.lines[9].calculation_snapshot.paymentLines.push(line);
  s.lines[10].calculation_snapshot.paymentLines.push({...line,count:10,amount:10*rate});
  s.worksheet.production_breakdown.push(line);
 }
 const items=disputeItems(s).filter(i=>i.kind==='production');
 return {s,items,raw:{issue:'production',component:items[0].key,concern:'Count is incorrect',dates:['2026-10-10'],counts:[{date:'2026-10-10',component:items[0].key,value:52},{date:'2026-10-10',component:items[1].key,value:5}]}};
}
test('daily delivery and return claims preserve separate inputs and exact pay impact',()=>{
 const {s,raw}=dailyCountFixture(),claim=normalizeGuidedClaim(s,raw),fields=guidedFields(s,claim),f=new FormData();
 assert.equal(fields.length,2);assert.deepEqual(fields.map(f=>[f.code,f.current,f.claimed]),[['DELIVERY',50,52],['C_RETURN',3,5]].sort((a,b)=>('earning:'+a[0]).localeCompare('earning:'+b[0])));
 for(const field of fields){f.set(field.key,String(field.claimed));f.set(`checked_${field.key}`,'on');}
 const p=buildGuidedPlan(s,claim,f,context);assert.equal(p.expected_delta_paise,2970);assert.equal(p.items.length,2);
 f.delete(`checked_${fields[1].key}`);assert.throws(()=>buildGuidedPlan(s,claim,f,context),/supporting evidence/);
 assert.deepEqual(normalizeGuidedClaim(s,claim),claim);
});
test('several dates work; unchanged items are omitted and unchanged dates must be unselected',()=>{
 const {s,items,raw}=dailyCountFixture();raw.dates.push('2026-10-11');raw.counts.push({date:'2026-10-11',component:items[0].key,value:11});raw.counts[1].value=3;
 const c=normalizeGuidedClaim(s,raw);assert.equal(c.counts.length,2);assert.equal(guidedFields(s,c).length,2);
 raw.counts[2].value=10;assert.throws(()=>normalizeGuidedClaim(s,raw),/each selected date/);
});
test('daily claims reject unknown items, unknown dates, fractions, duplicates, empty and missing counts',()=>{
 const {s,raw}=dailyCountFixture();
 for(const replacement of [{component:'attendance'},{date:'2026-10-09'},{value:-1},{value:1.5},{value:''},{value:null}]){
  const bad=structuredClone(raw);Object.assign(bad.counts[0],replacement);assert.throws(()=>normalizeGuidedClaim(s,bad));
 }
 assert.throws(()=>normalizeGuidedClaim(s,{...raw,counts:[raw.counts[0],raw.counts[0]]}),/only be included once/);
 assert.throws(()=>normalizeGuidedClaim(s,{...raw,counts:[]}),/correct counts/);
 s.lines[9].calculation_snapshot.paymentLines=[];assert.throws(()=>normalizeGuidedClaim(s,raw),/no published count/);
});
test('reviewer may validate a different whole-number count, never silently accept a claim',()=>{
 const {s,raw}=dailyCountFixture(),c=normalizeGuidedClaim(s,raw),fields=guidedFields(s,c),f=new FormData();
 for(const field of fields){f.set(field.key,String(field.current));f.set(`checked_${field.key}`,'on');}
 assert.throws(()=>buildGuidedPlan(s,c,f,context),/No value changed/);
 f.set(fields[0].key,'4.5');assert.throws(()=>buildGuidedPlan(s,c,f,context),/whole numbers/);
 f.set(fields[0].key,'4');assert.ok(buildGuidedPlan(s,c,f,context));
});
test('ownership and wrongful deduction claims need no replacement amount',()=>{
 const s=structuredClone(baseSnapshot);s.worksheet.deduction_breakdown.push({code:'LOSS_RECOVERY',label:'Loss',amount:500,recoveryKey:'2026-09|tid|worker'});
 const item=disputeItems(s).find(i=>i.code==='LOSS_RECOVERY');
 for(const concern of ['Not my loss','Wrongly deducted','Already recovered','Please explain this loss']){
  const c=normalizeGuidedClaim(s,{issue:'deduction',component:item.key,concern,expected:'999'});
  assert.equal(c.expected,'');assert.deepEqual(c.dates,[]);assert.equal(guidedFields(s,c)[0].current,500);
 }
});

test('per-package-only payouts do not offer an irrelevant attendance dispute',()=>{
 const line={work_date:'2026-10-10',provider_member_id:'200001',calculation_snapshot:{counts:{totalDelivery:20},paymentLines:[{code:'DELIVERY',label:'Delivery',schedule:'per_unit',rate:15,count:20,amount:300,componentType:'production'}]}};
 const s={item:{work_days:1,gross_amount:300,deduction_amount:0,net_amount:300},lines:[line],worksheet:{production_breakdown:[{code:'DELIVERY',label:'Delivery',schedule:'per_unit',rate:15,count:20,amount:300}],deduction_breakdown:[]}};
 const items=disputeItems(s);
 assert.equal(items.some(item=>item.kind==='attendance'),false);
 assert.deepEqual([...new Set(items.map(item=>item.kind))],['production']);
 assert.throws(()=>normalizeGuidedClaim(s,{issue:'attendance',component:'attendance',dates:['2026-10-10'],concern:'I worked but the day is missing'}),/actual payment/);
 const production=items[0];
 const c=normalizeGuidedClaim(s,{issue:'production',component:production.key,dates:['2026-10-10'],concern:'Count is incorrect',counts:[{date:'2026-10-10',component:production.key,value:40}]});
 const f=new FormData();f.set('value_0','40');f.set('checked_value_0','on');
 const p=buildGuidedPlan(s,c,f,{policies:[],percentageDeductions:[],checkedAt:'2026-11-10'});
 assert.equal(p.items[0].kind,'production');
 assert.equal(p.expected_delta_paise,30000);
});

test('mixed fixed and per-package payouts retain both attendance and production issues',()=>{
 const s=structuredClone(baseSnapshot);
 const delivery={code:'DELIVERY',label:'Delivery',schedule:'per_unit',rate:15,count:20,amount:300,componentType:'production'};
 s.lines[9].calculation_snapshot.paymentLines.push(delivery);
 s.worksheet.production_breakdown.push(delivery);
 const kinds=new Set(disputeItems(s).map(item=>item.kind));
 assert.equal(kinds.has('attendance'),true);
 assert.equal(kinds.has('production'),true);
});
