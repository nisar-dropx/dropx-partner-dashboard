import test from 'node:test';
import assert from 'node:assert/strict';
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
