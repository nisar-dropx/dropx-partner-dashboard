const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.cwd(),cache=new Map();let data={},paymentsError=false;
const db={from(table){let rows=[...(data[table]??[])],single=false;const q=new Proxy({}, {get(_,k){if(k==='then')return resolve=>resolve({data:single?rows[0]??null:rows,error:paymentsError&&table==='payment_requests'?{message:'unavailable'}:null});return (...a)=>{if(k==='eq')rows=rows.filter(r=>r[a[0]]===a[1]);if(k==='in')rows=rows.filter(r=>a[1].includes(r[a[0]]));if(k==='gte')rows=rows.filter(r=>r[a[0]]>=a[1]);if(k==='lte')rows=rows.filter(r=>r[a[0]]<=a[1]);if(k==='range')rows=rows.slice(a[0],a[1]+1);if(k==='is')rows=rows.filter(r=>(r[a[0]]??null)===a[1]);if(k==='maybeSingle'||k==='single')single=true;return q;}}});return q;}};
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(id=>{if(id==='server-only')return {};if(id.endsWith('/supabase-admin'))return {supabaseAdmin:db};if(id==='@/lib/ops-pulse/cod')return {todayKolkata:()=> '2026-10-25'};if(id.startsWith('@/'))return load(path.join(root,'src',id.slice(2)));if(id.startsWith('.'))return load(path.join(path.dirname(file),id));return require(id)},m,m.exports);return m.exports;}
const {loadWorkforcePayoutRows}=load('src/lib/workforce-payout-loader.ts');
const scenarios=[{client:'Amazon',model:'EDSP'},{client:'Flipkart',model:'ODH'},{client:'Flipkart',model:'MDH'}];
function fixture(client='Flipkart',fixed=false,model=client==='Amazon'?'EDSP':'ODH'){const provider=client.toUpperCase();data={stations:[{id:'station',company_id:'company',station_code:'CHM',location_model_id:'model',is_active:true,hide_from_location_list:false}],field_executive_provider_mappings:[{id:'mapping',company_id:'company',station_id:'station',provider_id:'provider',provider_member_id:'001234567890',workforce_id:'worker',payment_method_id:'method',payment_values:fixed?{FIXED:1000}:{DELIVERY:17},effective_from:'2026-10-01',status:'active',providers:{code:provider,name:client},payment_methods:{name:fixed?'Fixed per day':'Per packet'}}],workforce:[{id:'worker',company_id:'company',dropx_id:'TEST1',full_name:'Test worker',date_of_join:'2026-10-01',is_active:true}],location_models:[{id:'model',company_id:'company',code:model}],payment_field_provider_metrics:[{company_id:'company',provider_id:'provider',provider_model_id:'model',payment_field_id:'delivery',provider_production_metrics:{source_key:'total_delivery'},payment_fields:{code:'DELIVERY',label:'Delivery',field_type:'production'}}],payment_method_components:[{is_active:true,company_id:'company',payment_method_id:'method',component_code:fixed?'FIXED':'DELIVERY',component_type:fixed?'amount':'production',payment_fields:fixed?{id:'fixed',code:'FIXED',label:'Fixed per day',field_type:'amount',pay_schedule:'per_day',calculation_type:'fixed_daily',calculation_source:'attendance_eligibility'}:{id:'delivery',code:'DELIVERY',label:'Delivery',field_type:'production',pay_schedule:'per_unit'}}],workforce_attendance_capture_settings:[{company_id:'company',capture_method:'shipment_data',minimum_daily_deliveries:1,effective_from:'2026-01-01'}],cps_shipment_daily:['2026-10-12','2026-10-13'].map((work_date,i)=>({company_id:'company',station_code:'CHM',provider_employee_id:'001234567890',provider_employee_name:'Test worker',client,work_date,total_delivery:80+i*20,total_activity:80+i*20})),payment_requests:[]};}
async function calculate(){const r=await loadWorkforcePayoutRows('company',{hasAllLocationAccess:true,locationScopeIds:[]},'2026-10-12','2026-10-13',{includeLossRecoveries:false});assert.equal(r.error,null);assert.ok(r.rows.length);return r.rows[0];}
(async()=>{for(const {client,model} of scenarios){fixture(client,false,model);let row=await calculate();assert.equal(row.baseAmount,3060,`${client} baseline`);data.payment_requests=[{company_id:'company',source_system:'OPS_ADHOC_DA',location_id:'station',adhoc_client:client,adhoc_provider_employee_id:'001234567890',adhoc_work_date:'2026-10-12',status:'approved',adhoc_payout_policy:'work_day',request_no:'ADHOC-TEST'}];row=await calculate();assert.equal(row.baseAmount,3060,'Approval without payment must not exclude');data.payment_requests[0].status='processed';row=await calculate();assert.equal(row.baseAmount,1700,'Exclude only paid work day');assert.equal(row.production,100);assert.match(row.dailyBreakdown.find(d=>d.date==='2026-10-12').attendanceSource,/ADHOC-TEST/);data.payment_requests[0].adhoc_work_date='2026-10-14';row=await calculate();assert.equal(row.baseAmount,3060,'Other work date unaffected');data.payment_requests[0].adhoc_work_date='2026-10-12';data.payment_requests[0].adhoc_payout_policy='cash_recovery';row=await calculate();assert.equal(row.baseAmount,3060,'No second deduction for legacy recovery');}
for(const {client,model} of scenarios) for(const monthly of [false,true]) {
fixture(client,true,model);
if(monthly) {
  data.field_executive_provider_mappings[0].payment_values={FIXED:31000};
  Object.assign(data.payment_method_components[0].payment_fields,{pay_schedule:'per_month',calculation_type:'fixed_monthly'});
}
let row=await calculate();assert.equal(row.baseAmount,2000,client+' '+model+' daily/monthly MG baseline');
data.payment_requests=[{company_id:'company',source_system:'OPS_ADHOC_DA',location_id:'station',adhoc_client:client,adhoc_provider_employee_id:'001234567890',adhoc_work_date:'2026-10-12',status:'paid',adhoc_payout_policy:'work_day',request_no:'ADHOC-FIXED'}];
row=await calculate();assert.equal(row.baseAmount,1000,'Daily/monthly MG also excludes the paid day');assert.equal(row.workDays,1);
assert.equal(row.dailyBreakdown.find(d=>d.date==='2026-10-12').baseAmount,0);
}

// Exercise real mapped payouts, with rent and delivery components together.
for (const monthly of [false,true]) for (const effect of ['full_day','base_only']) {
 fixture('Amazon');
 data.field_executive_provider_mappings[0].payment_values={DELIVERY:17,RENT:monthly?31000:1000};
 data.payment_method_components.push({is_active:true,company_id:'company',payment_method_id:'method',component_code:'RENT',component_type:'amount',payment_fields:{id:'rent',code:'RENT',label:'ODCD rent',field_type:'amount',pay_schedule:monthly?'per_month':'per_day',calculation_type:monthly?'fixed_monthly':'fixed_daily',calculation_source:'attendance_eligibility'}});
 // The same delivery ID has base-station and XPT payment mappings.
 data.stations.push({...data.stations[0],id:'xpt',station_code:'XPT'});
 data.field_executive_provider_mappings.push({...data.field_executive_provider_mappings[0],id:'xpt-mapping',station_id:'xpt'});
 data.cps_shipment_daily.push(...data.cps_shipment_daily.map(r=>({...r,station_code:'XPT'})));
 const all=async()=>{const r=await loadWorkforcePayoutRows('company',{hasAllLocationAccess:true,locationScopeIds:[]},'2026-10-12','2026-10-13',{includeLossRecoveries:false});assert.equal(r.error,null);return r.rows;};
 let rows=await all();assert.equal(rows.reduce((n,r)=>n+r.baseAmount,0),10120,'Baseline: rent plus variable in both mappings');
 const payment={company_id:'company',location_id:'station',adhoc_client:'Amazon',delivery_identity_confirmed:true,delivery_work_date:'2026-10-12',delivery_provider_employee_id:'001234567890',delivery_performer_workforce_id:'worker',delivery_payout_station_ids:['station','xpt'],adhoc_payout_effect:effect,request_no:'VAN-TEST',status:'paid'};
 data.payment_requests=[payment];rows=await all();
 for (const row of rows) {
  assert.equal(row.baseAmount,effect==='full_day'?2700:4060,`${monthly?'Monthly':'Daily'} rent ${effect}: correct base/XPT amount`);
  const day=row.dailyBreakdown.find(d=>d.date==='2026-10-12');
  assert.equal(day.baseAmount,effect==='full_day'?0:1360,'Driver has no normal pay; ODCD keeps exactly variable delivery');
  assert.equal(row.dailyBreakdown.find(d=>d.date==='2026-10-13').baseAmount,2700,'Adjacent day unchanged');
  assert.equal(day.lines.filter(l=>l.code==='DELIVERY').reduce((n,l)=>n+l.count,0),effect==='full_day'?0:80,'Variable counts retained only for ODCD');
 }
 // Scope filtering must not lose the parent request when calculating only XPT.
 const scoped=await loadWorkforcePayoutRows('company',{hasAllLocationAccess:false,locationScopeIds:['xpt']},'2026-10-12','2026-10-13',{includeLossRecoveries:false});
 assert.equal(scoped.error,null);assert.equal(scoped.rows.length,1);assert.equal(scoped.rows[0].baseAmount,effect==='full_day'?2700:4060);
 data.payment_requests[0].status='approved';rows=await all();assert.equal(rows.reduce((n,r)=>n+r.baseAmount,0),10120,'Unpaid approval never silently deducts');
 data.payment_requests[0]={...payment,delivery_payout_station_ids:['station']};rows=await all();assert.equal(rows.find(r=>r.locationId==='xpt').baseAmount,5060,'Unrelated/unsnapshotted mapping untouched');
}
console.log('PASS real Workforce payouts: van driver full day zero; ODCD variable retained/rent removed, daily/monthly rent, parent and XPT, scoped XPT, adjacent-day and paid-only isolation.');

// Variable incentives must follow the same day exclusion as delivery production.
for(const effect of ['full_day','base_only']) {
 fixture('Amazon');
 data.cps_shipment_daily.forEach((r,i)=>r.id=`delivery-${i}`);
 data.workforce_incentive_campaigns=[{id:'bonus',company_id:'company',code:'BONUS',name:'Delivery bonus',provider_id:'provider',location_model_id:'model',station_id:null,designation_id:null,incentive_type:'performance',cycle_type:'daily',metric:'total_delivery',calculation_type:'per_unit_above_threshold',threshold_value:0,rate_value:1,flat_amount:0,maximum_amount:null,minimum_activity:0,tiers:[],effective_from:'2026-10-01',effective_to:'2026-10-31',status:'active',approved_at:'2026-10-01'}];
 let row=await calculate();assert.equal(row.incentiveAmount,180);
 data.payment_requests=[{company_id:'company',location_id:'station',adhoc_client:'Amazon',delivery_identity_confirmed:true,delivery_work_date:'2026-10-12',delivery_provider_employee_id:'001234567890',delivery_performer_workforce_id:'worker',delivery_payout_station_ids:['station'],adhoc_payout_effect:effect,request_no:'INCENTIVE-TEST',status:'paid'}];
 row=await calculate();assert.equal(row.incentiveAmount,effect==='full_day'?100:180,'Driver day cannot earn variable incentive; ODCD keeps variable incentive');
}
console.log('PASS Workforce variable incentives: driver day excluded, ODCD production retained.');

paymentsError=true;const failed=await loadWorkforcePayoutRows('company',{hasAllLocationAccess:true,locationScopeIds:[]},'2026-10-12','2026-10-13',{includeLossRecoveries:false});assert.match(failed.error,/verify paid ad hoc/);assert.equal(failed.rows.length,0);
console.log('PASS actual Workforce loader: Amazon and Flipkart amounts/counts, paid-only date isolation, daily and monthly MG across EDSP/ODH/MDH, legacy safety, fail closed on exclusion lookup failure.');})().catch(e=>{console.error(e);process.exitCode=1});
