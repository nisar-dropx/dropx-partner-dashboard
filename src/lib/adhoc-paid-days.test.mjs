import test from 'node:test';
import assert from 'node:assert/strict';
import { adhocDaIdentityFields, adhocPaidDayKey } from './adhoc-da-identity.ts';
import { paidAdhocDays, paidAdhocDayBreakdown } from './adhoc-paid-days.ts';
const record={location_id:'CHM-ID',adhoc_client:'Flipkart',adhoc_provider_employee_id:'001234567890',adhoc_work_date:'2026-10-12',status:'paid',adhoc_payout_policy:'work_day',request_no:'TEST-1'};
test('only bank-processed or paid work days exclude payroll, with no second cash deduction',()=>{
 for(const status of ['draft','pending','approved','processing','returned','resubmitted','cancelled','rejected']) assert.equal(paidAdhocDays([{...record,status}]).size,0);
 for(const status of ['processed','paid']) assert.equal(paidAdhocDays([{...record,status}]).size,1);
 assert.equal(paidAdhocDays([{...record,adhoc_payout_policy:'cash_recovery'}]).size,0);
 const day=paidAdhocDayBreakdown(record.adhoc_work_date,record.request_no);
 assert.equal(day.baseAmount,0);assert.equal(day.workDayUnits,0);assert.equal(day.lines.reduce((n,l)=>n+l.count,0),0);assert.match(day.lines[0].label,/TEST-1/);
});
test('late imports match stable provider/day identity, isolated by station/client/date',()=>{
 const days=paidAdhocDays([record]);
 const key=(s='CHM-ID',c='Flipkart',id='001234567890',d='2026-10-12')=>adhocPaidDayKey(s,c,id,d);
 assert.equal(days.get(key()),'TEST-1');
 assert.equal(days.get(key('OTHER')),undefined);assert.equal(days.get(key('CHM-ID','Amazon')),undefined);
 assert.equal(days.get(key('CHM-ID','Flipkart','001234567890','2026-10-13')),undefined);
 assert.equal(days.get(key('CHM-ID','Flipkart','1234567890')),undefined);
 const importTwoWeeksLater={station:'CHM-ID',client:'flipkart',id:'001234567890',date:'2026-10-12',deliveries:80,rate:17};
 const excluded=days.has(key(importTwoWeeksLater.station,importTwoWeeksLater.client,importTwoWeeksLater.id,importTwoWeeksLater.date));
 assert.equal(excluded?0:importTwoWeeksLater.deliveries*importTwoWeeksLater.rate,0);
});
test('manual FHR preserves leading zeroes and requires an actual work date',()=>{
 const form=new FormData();form.set('adhoc_identity_mode','manual_provider');form.set('adhoc_provider_employee_id','001234567890');
 assert.throws(()=>adhocDaIdentityFields(form),/date/);
 form.set('adhoc_work_date','2026-02-30');assert.throws(()=>adhocDaIdentityFields(form),/date/);
 form.set('adhoc_work_date','2026-10-12');const result=adhocDaIdentityFields(form);
 assert.equal(result.adhoc_provider_employee_id,'001234567890');assert.equal(result.adhoc_work_date,'2026-10-12');assert.equal(result.adhoc_payout_policy,'work_day');
});
