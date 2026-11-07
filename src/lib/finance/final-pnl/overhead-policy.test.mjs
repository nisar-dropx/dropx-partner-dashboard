import test from 'node:test';
import assert from 'node:assert/strict';
import {baseStations} from './model.ts';
import {defaultOverheadRules,deliveryVolumes,pnlRegion} from './overhead-policy.ts';
const dimension=(code,state,model='EDSP')=>({code,name:code,state,model,region:pnlRegion(state,'Unknown'),cluster:'',managers:[],isHo:false});
const location=(code,base=code,active=true,isHo=false)=>({code,base,active,isHo,aliases:[]});
test('regional volume, Amazon Now revenue and corporate vertical revenue remain distinct',()=>{
 const dims=[dimension('A','Andhra Pradesh'),dimension('O','Odisha'),dimension('C','Chhattisgarh'),dimension('N','Tamil Nadu','NOW'),dimension('OLD','Andhra Pradesh')];
 const rules=defaultOverheadRules('2026-09',dims,[...dims.map(d=>location(d.code,d.code,d.code!=='OLD')),...['HO_AP','HO_OD','HO_CG','HO_TN','HO_CLT','HO_MJR'].map(c=>location(c,c,true,true))]);
 assert.equal(rules.find(r=>r.station_code==='HO_AP').allocation,'volume');assert.deepEqual(rules.find(r=>r.station_code==='HO_AP').recipient_codes,['A']);
 assert.deepEqual(rules.find(r=>r.station_code==='HO_OD').recipient_codes,['O']);assert.deepEqual(rules.find(r=>r.station_code==='HO_CG').recipient_codes,['C']);assert.equal(pnlRegion('Odisha',''),'ODCG');assert.equal(pnlRegion('Chhattisgarh',''),'ODCG');
 assert.equal(rules.find(r=>r.station_code==='HO_TN').allocation,'revenue');for(const c of ['HO_CLT','HO_MJR']){const r=rules.find(r=>r.station_code===c);assert.equal(r.mode,'corporate');assert.equal(r.allocation,'revenue');assert.deepEqual(r.recipient_models,['EDSP','NOW']);}
});
test('actual XPT delivery rolls to base; absent feed is not zero and inactive volume never contributes',()=>{
 const t=[location('A'),location('X','A'),location('OLD','A',false),location('B')],d=[dimension('A','Kerala'),dimension('B','Kerala')];
 const rows=[['A',100],['X',50],['OLD',999]].map(([station_code,deliveries])=>({station_code,work_date:'2026-09-01',shipment_present:true,deliveries}));
 const v=deliveryVolumes('2026-09',rows,[],t,d);assert.equal(v[0].delivered,150);assert.deepEqual(v[0].missingSources,[]);assert.equal(v[1].delivered,null);assert.deepEqual(v[1].missingSources,['B']);
});

test('organizational HO parent links never merge separate office cost pools',()=>{
 const s=[{id:'mjr',station_code:'HO_MJR',parent_station_id:null,is_ho:true},{id:'clt',station_code:'HO_CLT',parent_station_id:'mjr',is_ho:true},{id:'base',station_code:'BASE',parent_station_id:'mjr',is_ho:false},{id:'xpt',station_code:'XPT',parent_station_id:'base',is_ho:false}];
 assert.deepEqual(baseStations(s,[]).map(s=>[s.code,s.base]),[['HO_MJR','HO_MJR'],['HO_CLT','HO_CLT'],['BASE','BASE'],['XPT','BASE']]);
});
test('missing or malformed delivered volume cannot silently become zero or contaminate HO weights',()=>{
 const topology=[location('A')],dimensions=[dimension('A','Kerala')];
 const daily=[{station_code:'A',work_date:'2026-08-31',shipment_present:true,deliveries:999},{station_code:'A',work_date:'2026-09-01',shipment_present:true,deliveries:10},{station_code:'A',work_date:'2026-09-02',shipment_present:true,deliveries:'bad'}];
 const result=deliveryVolumes('2026-09',daily,[],topology,dimensions)[0];assert.equal(result.delivered,10);assert.deepEqual(result.missingSources,['A']);assert.equal(result.reportedDays,1);
 for(const units of [null,undefined,'',-1,'bad']){const result=deliveryVolumes('2026-09',[],[{station_code:'A',month:'2026-09-01',units,through_date:'2026-09-30'}],topology,[dimension('A','Kerala','NOW')])[0];assert.equal(result.delivered,null);assert.deepEqual(result.missingSources,['A']);}
 const zero=deliveryVolumes('2026-09',[{station_code:'A',work_date:'2026-09-01',shipment_present:true,deliveries:0}],[],topology,dimensions)[0];assert.equal(zero.delivered,0);assert.deepEqual(zero.missingSources,[]);
});

test('explicit XPT reporting date scopes expected feeds without inventing volume or duplicating parent data',()=>{
 const topology=[location('A'),location('X','A')],dimensions=[dimension('A','Kerala')];
 const record={kind:'billing_period',data:{station_code:'X',reporting_from:'2026-11-05',fixed_payout_from:'2026-10-01',prior_reporting_station:'A'}};
 const parent={station_code:'A',work_date:'2026-10-31',shipment_present:true,deliveries:100};
 const before=deliveryVolumes('2026-10',[parent],[],topology,dimensions,[record])[0];
 assert.equal(before.delivered,100);assert.deepEqual(before.missingSources,[]);
 // No explicit rule retains the conservative missing-feed check.
 assert.deepEqual(deliveryVolumes('2026-10',[parent],[],topology,dimensions)[0].missingSources,['X']);
 const nextParent={...parent,work_date:'2026-11-05'};
 assert.deepEqual(deliveryVolumes('2026-11',[nextParent],[],topology,dimensions,[record])[0].missingSources,['X']);
 const child={station_code:'X',work_date:'2026-11-05',shipment_present:true,deliveries:20};
 const after=deliveryVolumes('2026-11',[nextParent,child],[],topology,dimensions,[record])[0];
 assert.equal(after.delivered,120);assert.deepEqual(after.missingSources,[]);
 // A stale pre-start child record does not prove the new feed is available.
 assert.deepEqual(deliveryVolumes('2026-11',[nextParent,{...child,work_date:'2026-11-01'}],[],topology,dimensions,[record])[0].missingSources,['X']);
});
test('parent-reporting master uses parent count once and never requires an unofficial child feed',()=>{
 const topology=[location('A'),location('X','A'),location('B')],dimensions=[dimension('A','Kerala'),dimension('B','Kerala')];
 const rows=[{station_code:'A',work_date:'2026-10-31',shipment_present:true,deliveries:100},{station_code:'X',work_date:'2026-10-31',shipment_present:true,deliveries:20}];
 const record={kind:'shipment_reporting',data:{station_code:'X',mode:'parent',parent_station_code:'A',source:'Confirmed'}};
 const parent=deliveryVolumes('2026-10',rows,[],topology,dimensions,[record])[0];assert.equal(parent.delivered,100);assert.deepEqual(parent.missingSources,[]);
 assert.deepEqual(deliveryVolumes('2026-10',rows.slice(1),[],topology,dimensions,[record])[0].missingSources,['A']);
 const separate=deliveryVolumes('2026-10',rows,[],topology,dimensions,[{...record,data:{...record.data,mode:'separate'}}])[0];assert.equal(separate.delivered,120);
 const invalid=deliveryVolumes('2026-10',rows.slice(0,1),[],topology,dimensions,[{...record,data:{...record.data,parent_station_code:'B'}}])[0];assert.deepEqual(invalid.missingSources,['X']);
});
