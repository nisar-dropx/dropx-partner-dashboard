import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cReturnSummary,cReturnTotal,requireReportFreshness,performanceTitle} from './lm-live-report.ts';
const day='2026-11-12';
const r=(id,state,driverId='',edd=day,stationCode='QLDA')=>({trackingId:id,state,driverId,edd,stationCode});
test('today-only pickup counts distinguish unassigned stock, assigned work and failures',()=>{
 const rows=[r('1','AT_STATION'),r('2','AT_STATION','DA'),r('3','ON_ROAD_WITH_DELIVERY_ASSOCIATE','DA'),r('4','PICKUP_DONE','DA'),r('5','PICKUP_FAILED','DA'),r('6','CANCELLED'),r('7','DELAYED'),r('8','UNPICKUPABLE'),r('9','DELIVERED','DA','2026-11-11'),r('10','AT_STATION','','2026-11-13'),r('11','PICKUP_DONE','DA',day,'TLPA'),r('4','PICKUP_DONE','DA')];
 const summary=cReturnSummary('QLDA',day,rows);
 assert.equal(summary.Scheduled,8);assert.equal(summary['At station'],1);assert.equal(summary.Assigned,4);assert.equal(summary['On road'],1);assert.equal(summary['Picked up'],1);assert.equal(summary['Pickup failed'],1);assert.equal(summary.Cancelled,1);assert.equal(summary.Unpickupable,1);assert.equal(summary['Pickup %'],'12.5%');
});
test('grand pickup percentage is weighted by actual scheduled totals',()=>{
 const a=cReturnSummary('QLDA',day,[r('a','PICKUP_DONE')]);const b={...a,Station:'TLPA',Scheduled:9,'Picked up':0,'Pickup %':'0.0%'};
 assert.equal(cReturnTotal([a,b])['Pickup %'],'10.0%');
});
test('live data at five minutes passes; previous-hour, previous-day and future data fails',()=>{
 const now=Date.parse(day+'T08:04:00+05:30');
 assert.ok(requireReportFreshness(new Date(now-300000).toISOString(),day,5,now));
 for(const delta of [300001,3600000,86400000,-120000])assert.throws(()=>requireReportFreshness(new Date(now-delta).toISOString(),day,5,now),/refresh/);
});
test('short titles show the report, date and live data time only',()=>{
 assert.equal(performanceTitle('creturn','2026-11-11'),'C-return · 11 Nov');
 const title=performanceTitle('dsr',day,day+'T08:02:00+05:30','08:00');assert.match(title,/At-station status · 12 Nov · 8:02 am IST/);assert.doesNotMatch(title,/2026|Region|Internal/);
});


test('missing or incomplete physical rows cannot become a false zero', async () => {
 const { verifiedPhysicalCount } = await import('./lm-live-report.ts');
 assert.throws(()=>verifiedPhysicalCount(undefined,new Set()));
 assert.throws(()=>verifiedPhysicalCount(1000,new Set()));
 assert.equal(verifiedPhysicalCount(0,new Set()),0);
 assert.equal(verifiedPhysicalCount(2,new Set(['old-HFR','future'])),2);
});
