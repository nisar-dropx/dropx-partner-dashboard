import test from 'node:test';
import assert from 'node:assert/strict';
import {teamShift,isStationLead} from './cod-station-team-core.ts';
const person={workerId:'tl1',workerType:'employee'};
const day='2026-10-13';
const plan={status:'approved',roster_kind:'recurring_weekly',effective_from:'2026-10-01'};
const row={worker_id:'tl1',worker_type:'employee',roster_date:'2026-10-06',day_type:'working',plan,shift:{name:'Morning',start_time:'08:00:00',end_time:'17:00:00'}};
test('approved recurring shift follows weekday and never uses another worker',()=>{
 assert.equal(teamShift(person,[row],day),'Morning · 08:00–17:00 IST');
 assert.equal(teamShift(person,[row],'2026-10-14'),'Shift not rostered');
 assert.equal(teamShift({workerId:'another',workerType:'employee'},[row],day),'Shift not rostered');
});
test('dated off overrides weekly shift, drafts and superseded patterns are excluded',()=>{
 const off={...row,roster_date:day,day_type:'weekly_off',plan:{...plan,roster_kind:'dated'}};
 assert.equal(teamShift(person,[row,off],day),'weekly off');
 assert.equal(teamShift(person,[{...row,plan:{...plan,status:'draft'}}],day),'Shift not rostered');
 assert.equal(teamShift(person,[{...row,plan:{...plan,superseded_at:'2026-10-10'}}],day),'Shift not rostered');
});
test('night shift identifies next-day finish and incomplete roster does not invent hours',()=>{
 assert.equal(teamShift(person,[{...row,shift:{name:'Night',start_time:'22:00:00',end_time:'06:00:00'}}],day),'Night · 22:00–06:00 (+1 day) IST');
 assert.equal(teamShift(person,[{...row,shift:null}],day),'Shift not set');
});
test('station lead includes TL and station managers but not support staff or cluster',()=>{
 for(const roleCode of ['TL','ATL','STM'])assert.equal(isStationLead({roleCode,role:''}),true);
 assert.equal(isStationLead({roleCode:'',role:'Team Leader'}),true);
 assert.equal(isStationLead({roleCode:'SSA',role:'Station Support Associate'}),false);
 assert.equal(isStationLead({roleCode:'CLM',role:'Cluster Manager'}),false);
});
