import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeScrub, scrubDays, scrubStationRows, filterScrubRows, scrubCsv} from './scrub-summary.ts';
const now=new Date('2026-10-29T10:00:00Z'), fetched='2026-10-29T09:00:00Z';
const activity=(times=[],error=null)=>({lastAt:times[0]??null,invocations:times.map(at=>({at,operator:'Operator'})),error});
test('IST day boundary, unique scrub days and pending calendar days',()=>{
 const a=summarizeScrub(activity(['2026-10-28T18:31:00Z','2026-10-28T18:35:00Z']),fetched,now);
 assert.equal(a.status,'done');assert.equal(a.pendingDays,0);assert.equal(a.daysScrubbed,1);assert.equal(a.lastAt,'2026-10-28T18:35:00Z');
 const b=summarizeScrub(activity(['2026-10-26T18:29:00Z']),fetched,now);
 assert.equal(b.pendingDays,3);assert.equal(b.label,'3d pending');
 assert.deepEqual(scrubDays(new Date('2026-10-28T18:31:00Z')),['2026-10-29','2026-10-28','2026-10-27','2026-10-26','2026-10-25','2026-10-24','2026-10-23']);
});
test('empty current 7-day log is a lower bound, missing and stale data are not pending',()=>{
 assert.equal(summarizeScrub(activity(),fetched,now).label,'7+ days pending');
 for(const [a,time,status] of [[activity(),null,'unavailable'],[activity([], 'Timeout'),fetched,'unavailable'],[activity(['2026-10-27T12:00:00Z']),'2026-10-28T12:00:00Z','stale']]){
  const v=summarizeScrub(a,time,now);assert.equal(v.status,status);assert.equal(v.pendingDays,null);
 }
 const proof=summarizeScrub(activity(['2026-10-29T01:00:00Z'],'Refresh failed'),fetched,now);assert.equal(proof.status,'done');
});
const data=[
 {stationCode:'AAA',fetchedAt:fetched,inStation:activity(['2026-10-29T01:00:00Z']),onRoad:activity(['2026-10-28T01:00:00Z'])},
 {stationCode:'BBB',fetchedAt:fetched,inStation:activity(),onRoad:activity(['2026-10-29T02:00:00Z'])},
 {stationCode:'OUT',fetchedAt:fetched,inStation:activity(),onRoad:activity()}
];
const names={AAA:'Alpha',BBB:'Beta',CCC:'Missing'};
const clusters=[{value:'people:1',label:'Same name',stations:['AAA']},{value:'people:2',label:'Same name',stations:['BBB']}];
const filters={stations:[],clusters:[],inStation:[],onRoad:[],search:'',sort:'pending'};
test('one row per station, both types, missing stations visible and out-of-scope rows excluded',()=>{
 const rows=scrubStationRows(data,names,now);assert.deepEqual(rows.map(r=>r.stationCode),['AAA','BBB','CCC']);
 assert.equal(rows[0].inStation.status,'done');assert.equal(rows[0].onRoad.pendingDays,1);assert.equal(rows[2].inStation.status,'unavailable');
});
test('multi-select station/People-cluster/type-status intersection and sorting retain scope',()=>{
 const rows=scrubStationRows(data,names,now);
 assert.deepEqual(filterScrubRows(rows,clusters,filters).map(r=>r.stationCode),['BBB','AAA','CCC']);
 assert.deepEqual(filterScrubRows(rows,clusters,{...filters,stations:['AAA','BBB'],clusters:['people:1','people:2'],inStation:['done','none'],onRoad:['pending']}).map(r=>r.stationCode),['AAA']);
 assert.equal(filterScrubRows(rows,clusters,{...filters,stations:['OUT']}).length,0);
 assert.equal(filterScrubRows(rows,clusters,{...filters,clusters:['people:2'],search:'beta'})[0].stationCode,'BBB');
 assert.deepEqual(filterScrubRows(rows,clusters,{...filters,sort:'latest'}).map(r=>r.stationCode),['BBB','AAA','CCC']);
 assert.deepEqual(filterScrubRows(rows,clusters,{...filters,sort:'onRoad'}).map(r=>r.stationCode),['AAA','CCC','BBB']);
 assert.equal(filterScrubRows(rows,clusters,{...filters,clusters:['invalid']}).length,0);
});
test('CSV exports both scrub types in the filtered station row and protects formula-like text',()=>{
 const rows=scrubStationRows(data,{AAA:'=SUM(1,2)'},now);const csv=scrubCsv(rows);
 assert.match(csv,/In-station status/);assert.match(csv,/On-road status/);assert.match(csv,/'=SUM\(1,2\)/);assert.doesNotMatch(csv,/BBB|OUT/);
 assert.equal(csv.split('\r\n').length,2);
});
