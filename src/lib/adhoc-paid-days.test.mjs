import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adhocDaIdentityFields, adhocPaidDayKey } from './adhoc-da-identity.ts';
import { paidAdhocDays, paidAdhocDayBreakdown } from './adhoc-paid-days.ts';
import { deliveryIdentityFields, normalizeDeliveryIdentityPolicy } from './adhoc-delivery-identity.ts';
const record={location_id:'CHM-ID',adhoc_client:'Flipkart',adhoc_provider_employee_id:'001234567890',adhoc_work_date:'2026-10-12',status:'paid',adhoc_payout_policy:'work_day',request_no:'TEST-1'};
test('only bank-processed or paid work days exclude payroll, with no second cash deduction',()=>{
 for(const status of ['draft','pending','approved','processing','returned','resubmitted','cancelled','rejected']) assert.equal(paidAdhocDays([{...record,status}]).size,0);
 for(const status of ['processed','paid']) assert.equal(paidAdhocDays([{...record,status}]).size,1);
 assert.equal(paidAdhocDays([{...record,adhoc_payout_policy:'cash_recovery'}]).size,0);
 const day=paidAdhocDayBreakdown(record.adhoc_work_date,{requestNo:record.request_no,effect:'full_day'});
 assert.equal(day.baseAmount,0);assert.equal(day.workDayUnits,0);assert.equal(day.lines.reduce((n,l)=>n+l.count,0),0);assert.match(day.lines[0].label,/TEST-1/);
});
test('late imports match stable provider/day identity, isolated by station/client/date',()=>{
 const days=paidAdhocDays([record]);
 const key=(s='CHM-ID',c='Flipkart',id='001234567890',d='2026-10-12')=>adhocPaidDayKey(s,c,id,d);
 assert.deepEqual(days.get(key()),{requestNo:'TEST-1',effect:'full_day',workforceId:undefined});
 assert.equal(days.get(key('OTHER')),undefined);assert.equal(days.get(key('CHM-ID','Amazon')),undefined);
 assert.equal(days.get(key('CHM-ID','Flipkart','001234567890','2026-10-13')),undefined);
 assert.equal(days.get(key('CHM-ID','Flipkart','1234567890')),undefined);
 const importTwoWeeksLater={station:'CHM-ID',client:'flipkart',id:'001234567890',date:'2026-10-12',deliveries:80,rate:17};
 const excluded=days.has(key(importTwoWeeksLater.station,importTwoWeeksLater.client,importTwoWeeksLater.id,importTwoWeeksLater.date));
 assert.equal(excluded?0:importTwoWeeksLater.deliveries*importTwoWeeksLater.rate,0);
});
test('van and ODCD identity choices produce auditable fields for the database policy',()=>{
 const form=new FormData();form.set('delivery_work_date','2026-11-04');form.set('delivery_performer_mode','existing_odcd');form.set('delivery_provider_employee_id','ODCD123');form.set('delivery_identity_confirmed','yes');
 const van=deliveryIdentityFields(form,'van_execution');
 assert.equal(van.delivery_performer_mode,'existing_odcd');assert.equal(van.delivery_provider_employee_id,'ODCD123');assert.equal(van.delivery_identity_confirmed,true);
 const odcd=deliveryIdentityFields(form,'paid_associate_day');
 assert.equal(odcd.delivery_performer_mode,'standalone_odcd');
 form.delete('delivery_identity_confirmed');assert.throws(()=>deliveryIdentityFields(form,'van_execution'),/Confirm/);
});
test('master policy preserves the established Ad hoc DA identity fields',()=>{
 const form=new FormData();form.set('adhoc_identity_mode','manual_provider');form.set('adhoc_provider_employee_id','DA-100');form.set('adhoc_work_date','2026-11-04');
 const fields=adhocDaIdentityFields(form);
 assert.equal(fields.adhoc_provider_employee_id,'DA-100');assert.equal(fields.adhoc_work_date,'2026-11-04');
 assert.equal(normalizeDeliveryIdentityPolicy('legacy_adhoc_da'),'legacy_adhoc_da');
 assert.deepEqual(deliveryIdentityFields(form,'legacy_adhoc_da'),{});
});
test('delivery-linked paid days preserve full-day versus base-only treatment',()=>{
 const linked={...record,adhoc_provider_employee_id:null,adhoc_work_date:null,adhoc_payout_policy:'cash_recovery',delivery_identity_confirmed:true,delivery_provider_employee_id:'ODCD123',delivery_work_date:'2026-11-04',delivery_performer_workforce_id:'worker-1',adhoc_payout_effect:'base_only'};
 const treatment=paidAdhocDays([linked]).get(adhocPaidDayKey(linked.location_id,linked.adhoc_client,linked.delivery_provider_employee_id,linked.delivery_work_date));
 assert.deepEqual(treatment,{requestNo:'TEST-1',effect:'base_only',workforceId:'worker-1'});
 assert.equal(paidAdhocDays([{...linked,adhoc_payout_effect:'none'}]).size,0);
});
test('manual FHR preserves leading zeroes and requires an actual work date',()=>{
 const form=new FormData();form.set('adhoc_identity_mode','manual_provider');form.set('adhoc_provider_employee_id','001234567890');
 assert.throws(()=>adhocDaIdentityFields(form),/date/);
 form.set('adhoc_work_date','2026-02-30');assert.throws(()=>adhocDaIdentityFields(form),/date/);
 form.set('adhoc_work_date','2026-10-12');const result=adhocDaIdentityFields(form);
 assert.equal(result.adhoc_provider_employee_id,'001234567890');assert.equal(result.adhoc_work_date,'2026-10-12');assert.equal(result.adhoc_payout_policy,'work_day');
});
test('pre-activation bank rows can finish without weakening new-request identity checks',()=>{
 const migration=readFileSync(new URL('../../supabase/migrations/20261104202500_preserve_inflight_delivery_payments.sql',import.meta.url),'utf8');
 assert.match(migration,/before insert on public\.payment_requests[\s\S]*?payment_delivery_identity_guard\(\)/);
 assert.match(migration,/before delete on public\.payment_requests[\s\S]*?payment_delivery_identity_guard\(\)/);
 assert.match(migration,/old\.delivery_identity_confirmed is false[\s\S]*?lower\(old\.status\) in \('processing', 'processed', 'paid'\)[\s\S]*?lower\(new\.status\) in \('processing', 'processed', 'paid'\)/);
 assert.match(migration,/new\.company_id[\s\S]*?new\.adhoc_client[\s\S]*?is not distinct from row\([\s\S]*?old\.company_id[\s\S]*?old\.adhoc_client/);
});

test('confirmed station snapshots expand only their mapped ID/date; full-day wins regardless of order',()=>{
 const linked={...record,delivery_identity_confirmed:true,delivery_provider_employee_id:'ODCD123',delivery_work_date:'2026-11-04',delivery_performer_workforce_id:'worker-1',delivery_payout_station_ids:['CHM-ID','XPT-ID'],adhoc_payout_effect:'base_only'};
 for(const records of [[linked,{...linked,adhoc_payout_effect:'full_day'}],[{...linked,adhoc_payout_effect:'full_day'},linked]]) {
  const days=paidAdhocDays(records);assert.equal(days.size,2);
  for(const station of linked.delivery_payout_station_ids) assert.equal(days.get(adhocPaidDayKey(station,linked.adhoc_client,'ODCD123','2026-11-04')).effect,'full_day');
  assert.equal(days.has(adhocPaidDayKey('OTHER',linked.adhoc_client,'ODCD123','2026-11-04')),false);
 }
 assert.equal(paidAdhocDays([{...linked,delivery_payout_station_ids:[]}]).size,1,'Legacy confirmed rows preserve their original station');
 assert.equal(paidAdhocDays([{...linked,delivery_identity_confirmed:false}]).size,1,'Unconfirmed snapshots cannot expand a legacy deduction');
});
