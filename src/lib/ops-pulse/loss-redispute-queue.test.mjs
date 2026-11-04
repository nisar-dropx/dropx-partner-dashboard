import test from 'node:test';
import assert from 'node:assert/strict';
import { redisputeStatus, redisputeFollowup, ticketUpdateError } from './loss-redispute-queue.ts';
const window = {enabled:true, workflow_status:'with_vendor', followup_status:'filed', followup_on:'2026-11-03'};
test('manual ticket statuses and terminal recovery are distinct',()=>{
 assert.equal(redisputeStatus(window),'Ticket raised');
 assert.equal(redisputeStatus({...window,followup_status:'with_vendor'}),'Awaiting response from Amazon');
 assert.equal(redisputeStatus({...window,enabled:false,workflow_status:'won'}),'Recovered · redispute successful');
 assert.equal(redisputeStatus({...window,workflow_status:'approved'}),'Confirmed · ticket to raise');
});
test('follow-up tasks ignore closed cases and distinguish today and overdue',()=>{
 assert.equal(redisputeFollowup(window,'2026-11-03'),'today');
 assert.equal(redisputeFollowup(window,'2026-11-04'),'overdue');
 assert.equal(redisputeFollowup(window,'2026-11-02'),'upcoming');
 assert.equal(redisputeFollowup({...window,enabled:false},'2026-11-04'),'');
 assert.equal(redisputeFollowup({...window,workflow_status:'awaiting_review'},'2026-11-04'),'');
});
test('ticket validation rejects skipped IDs, invalid dates, links and status spoofing',()=>{
 const valid={tt_reference:'AMZ-123',tt_url:'https://example.com/ticket',followup_on:'2026-11-04',followup_status:'filed'};
 assert.equal(ticketUpdateError('tracking',valid),null);
 for(const invalid of [{tt_reference:''},{tt_reference:'x'.repeat(161)},{followup_on:'2026-02-30'},{followup_on:'today'},{followup_status:'won'},{tt_url:'javascript:alert(1)'},{tt_url:'https://secret@example.com'}])assert.ok(ticketUpdateError('tracking',{...valid,...invalid}));
 assert.equal(ticketUpdateError('won',{...valid,followup_on:''}),null);
 assert.equal(ticketUpdateError('approve',{...valid,tt_reference:''}),null);
});
