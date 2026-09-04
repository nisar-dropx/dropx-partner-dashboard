import assert from 'node:assert/strict';
import test from 'node:test';
import { managerReviewChain, reviewCapabilities, connectionTimes, discussionFeedUpdates, legacyConnectionsFromReview, reviewRole } from './review-policy.ts';
const person=(role,id=role)=>({role,personId:id});
test('CM to AOM to National Head; excludes station review stage',()=>{
  assert.deepEqual(managerReviewChain(['Team Lead','Cluster Manager','Area Operations Manager','National Head'].map(role=>person(role))).map(p=>p.role),['Cluster Manager','Area Operations Manager','National Head']);
});
test('direct national reporting does not add an AOM',()=>{
  assert.deepEqual(managerReviewChain(['Team Lead','Cluster Manager','National Head'].map(role=>person(role))).map(p=>p.role),['Cluster Manager','National Head']);
});
test('no cluster manager uses actual AOM and deduplicates identities',()=>{
  assert.deepEqual(managerReviewChain([person('Team Lead'),person('Area Operations Manager','a'),person('Area Operations Manager','a'),person('National Head')]).map(p=>p.role),['Area Operations Manager','National Head']);
});
const base={userId:'tl',owner:false,programManager:false,stationUser:false,inScope:true,canView:true,canAdd:true,canEdit:true,closed:false,firstReviewerId:'cm',currentReviewerId:'cm',currentRole:'Cluster Manager'};
test('station editor can only enter connection timings',()=>{
  const access=reviewCapabilities({...base,stationUser:true});
  assert.deepEqual(access,{canStart:false,canEditConnections:true,canEditRca:false,canComment:false,canComplete:false});
});
test('CM owns RCA, own stage, and can enter connection timings',()=>{
  assert.equal(reviewCapabilities({...base,userId:'cm'}).canEditRca,true);
  assert.equal(reviewCapabilities({...base,userId:'cm'}).canEditConnections,true);
  assert.equal(reviewCapabilities({...base,userId:'cm',currentReviewerId:'aom',currentRole:'Area Operations Manager'}).canEditRca,false);
  assert.equal(reviewCapabilities({...base,userId:'cm',currentReviewerId:'aom',currentRole:'Area Operations Manager'}).canEditConnections,false);
});
test('AOM comments but does not overwrite cluster RCA',()=>{
  const access=reviewCapabilities({...base,userId:'aom',currentReviewerId:'aom',currentRole:'Area Operations Manager'});
  assert.equal(access.canComment,true);assert.equal(access.canComplete,true);assert.equal(access.canEditRca,false);assert.equal(access.canEditConnections,false);
});
test('Program Manager edits/comments at all stages including closed, not another managers completion',()=>{
  for(const closed of [false,true]){
    const access=reviewCapabilities({...base,userId:'pm',programManager:true,closed});
    assert.equal(access.canEditRca,true);assert.equal(access.canComment,true);assert.equal(access.canEditConnections,true);assert.equal(access.canComplete,false);
  }
});
test('location scope and page permissions remain enforced even for oversight',()=>{
  for(const override of [{inScope:false},{canView:false},{canEdit:false,canAdd:false}])assert.ok(Object.values(reviewCapabilities({...base,owner:true,programManager:true,...override})).every(v=>!v));
});
test('role classification includes TL, location mail accounts and People PGM',()=>{
  assert.equal(reviewRole('OPERATIONS_LOCATION'), 'station');assert.equal(reviewRole('TL Team Lead'),'station');assert.equal(reviewRole('PGM Program Manager'),'program');assert.equal(reviewRole('PROGRAM_HEAD'),'program');
});
test('connection handles overnight completion and saves in IST',()=>{
  assert.deepEqual(connectionTimes({arrival:'2026-09-01T23:30',unloading:'2026-09-02T00:20',clearance:'2026-09-02T01:00'},'2026-09-01'),{arrival:'2026-09-01T18:00:00.000Z',unloading:'2026-09-01T18:50:00.000Z',clearance:'2026-09-01T19:30:00.000Z'});
});
test('partial connection allowed; chronology and invalid dates rejected',()=>{
  assert.equal(connectionTimes({arrival:'2026-09-01T07:00',unloading:'',clearance:''},'2026-09-01').unloading,null);
  for(const values of [
    {arrival:'2026-09-01T07:00',unloading:'2026-09-01T06:00',clearance:''},
    {arrival:'2026-09-01T07:00',unloading:'',clearance:'2026-09-01T08:00'},
    {arrival:'2026-02-30T07:00',unloading:'',clearance:''},
    {arrival:'2026-09-02T07:00',unloading:'',clearance:''}
  ])assert.throws(()=>connectionTimes(values,'2026-09-01'));
});
test('discussion feed hides RCA/takeaway noise and identical repeats',()=>{
  const rows=discussionFeedUpdates([
    {id:'1',update_type:'action',note:'DSR\nRCA: late',created_by:'a',author_name:'A'},
    {id:'2',update_type:'review',note:'Takeaway: focus on DDS',created_by:'a',author_name:'A'},
    {id:'3',update_type:'review',note:'Need FE coverage',created_by:'a',author_name:'A'},
    {id:'4',update_type:'review',note:'Need FE coverage',created_by:'a',author_name:'A'},
    {id:'5',update_type:'status',note:'Review route updated',created_by:null,author_name:'System'}
  ]);
  assert.deepEqual(rows.map((row)=>row.id),['3','5']);
});
test('legacy review vehicle times resurface as a connection',()=>{
  const [connection]=legacyConnectionsFromReview({
    id:'rev-1',station_id:'st-1',source_date:'2026-09-01',vehicle_arrival_time:'23:30:00',
    unloading_complete_time:'00:20:00',station_clear_time:'01:00:00',updated_at:'2026-09-02T01:00:00.000Z'
  });
  assert.equal(connection.label,'Connection 1');
  assert.equal(connection.arrival_at,'2026-09-01T18:00:00.000Z');
  assert.equal(connection.unloading_at,'2026-09-01T18:50:00.000Z');
  assert.equal(connection.clearance_at,'2026-09-01T19:30:00.000Z');
});
