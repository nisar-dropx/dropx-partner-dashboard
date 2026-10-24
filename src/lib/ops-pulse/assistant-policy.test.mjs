import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCatalog, assistantDates, checkedArguments, suggestedTools } from './assistant-policy.ts';
import { factualAnswer } from './assistant-answer.ts';
const dates = {from:'2026-10-01',to:'2026-10-25',asOf:'2026-10-25'};
test('TCC3 shifts and attendance never route to SPR, including from capacity page',()=>{
 for(const question of ["what’s the current shift status of tcc3?",'Who is working today?', 'Who has not reported?', 'Punches for TCC3']) assert.deepEqual(suggestedTools(question,true),['ops_shift_status']);
 assert.deepEqual(suggestedTools('Tell me about an unknown subject',false),[]);
});
test('catalog respects permissions and DS versus LM; no raw SQL or write tool',()=>{
 const ds=assistantCatalog(()=>true,true),lm=assistantCatalog(()=>true,false);
 assert(ds.some(t=>t.name==='ops_shift_status')); assert(ds.some(t=>t.name==='ops_store_ops_summary'));
 assert(!ds.some(t=>t.name==='ops_capacity_snapshot')); assert(!lm.some(t=>t.name==='ops_cpu_snapshot'));
 const restricted=assistantCatalog(c=>['ops_pulse','ops_rostering'].includes(c),true);
 assert(!restricted.some(t=>/audit|payment|document/.test(t.name)));
 assert.equal(assistantCatalog(()=>false,false).length,0);
 assert(ds.every(t=>!/(write|sql|approve|submit)/i.test(t.name)));
});
test('server intersects requested stations, rejects mixed unauthorized scope and invalid dates',()=>{
 assert.deepEqual(checkedArguments({},['TCC3'],dates).stationCodes,['TCC3']);
 assert.deepEqual(checkedArguments({stationCodes:['tcc3']},['TCC3'],dates).stationCodes,['TCC3']);
 for(const args of [{stationCodes:['TCC3','KTUR']},{stationCodes:'KTUR'},{from:'2026-02-30'},{from:'2025-01-01'}, {from:'2026-11-01'}]) assert.throws(()=>checkedArguments(args,['TCC3'],dates));
});
test('today, yesterday, periods and explicit ISO dates are resolved without stale history',()=>{
 assert.deepEqual(assistantDates('current shift status','2026-10-25'),{from:'2026-10-25',to:'2026-10-25',asOf:'2026-10-25'});
 assert.equal(assistantDates('yesterday','2026-10-01').asOf,'2026-09-30');
 assert.equal(assistantDates('last 7 days','2026-10-25').from,'2026-10-19');
 assert.deepEqual(assistantDates('2026-10-02 to 2026-10-06','2026-10-25'),{from:'2026-10-02',to:'2026-10-06',asOf:'2026-10-06'});
 assert.throws(()=>assistantDates('2026-02-30','2026-10-25'));
});
test('missing shift/delivery data is never described as zero operational activity',()=>{
 const shift=factualAnswer([{name:'ops_shift_status',data:{asOf:'2026-10-25',rows:[{stationCode:'TCC3',dataAvailable:false}]}}]);
 assert.match(shift,/does not establish/); assert.doesNotMatch(shift,/SPR|0 delivered/);
 const delivery=factualAnswer([{name:'ops_station_delivery_summary',data:{rows:[{stationCode:'TCC3',latestDeliveryDate:null,deliveredPackages:0}]}}]);
 assert.match(delivery,/no delivery data/); assert.doesNotMatch(delivery,/delivered packages: 0/);
});
test('fallback distinguishes unreported and upcoming shifts, with explicit date and source',()=>{
 const answer=factualAnswer([{name:'ops_shift_status',data:{asOf:'2026-10-25',rows:[{stationCode:'TCC3',dataAvailable:true,scheduled:6,punched:3,notReported:1,upcoming:2,late:1,onLeave:0,noRoster:1,rosterPending:0}]}}]);
 assert.match(answer,/3 punched, 1 not reported, 2 upcoming/);assert.match(answer,/2026-10-25 IST/);
});
