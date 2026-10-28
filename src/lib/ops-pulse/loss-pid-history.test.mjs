import test from 'node:test';
import assert from 'node:assert/strict';
import {historyChanges,pidEvent,historyRows,sortPidEvents} from './loss-pid-history.ts';
test('history compares both values and strips nested private salary information',()=>{
 const before={outcome_label:'Recover',allocations:[{full_name:'Person',amount:100,salary_gross:99999,reserved:200}]};
 const after={outcome_label:'Person left',allocations:[{full_name:'Person',amount:200,salary_gross:88888,reserved:300}],updated_at:'now'};
 const changes=historyChanges(before,after);
 assert.equal(changes.length,2);
 assert.equal(JSON.stringify(changes).includes('99999'),false);
 assert.equal(JSON.stringify(changes).includes('salary'),false);
 assert.equal(historyChanges({allocations:[{amount:100,salary_gross:1}]},{allocations:[{amount:100,salary_gross:2}]}).length,0);
});
test('same timestamp events have stable ordering and every older event survives export',()=>{
 const events=Array.from({length:1201},(_,i)=>pidEvent('Recovery',{id:String(i).padStart(4,'0'),month:'2026-09',case_key:'T1',created_at:'2026-10-28T03:00:00Z',actor_name:'Editor',before_value:{remarks:'before'},after_value:{remarks:`after ${i}`}}));
 assert.equal(sortPidEvents([...events])[0].id,'Recovery:0000');
 const rows=historyRows(events,new Map([['2026-09|T1','000001']]));
 assert.equal(rows.length,1201);assert.equal(rows[0][0],'000001');assert.equal(rows[0][3],1201);assert.equal(rows.at(-1)[3],1);
 assert.equal(rows[0][5],'Editor');assert.match(rows[0][4],/08:30:00/);
});
test('redispute events preserve before/after and missing actor stays explicit',()=>{
 const event=pidEvent('Redispute',{id:'a',month:'2026-09',case_key:'T',action:'revoke',created_at:'2026-10-28',note:'Enabled by mistake',tracking:{before:{enabled:true},after:{enabled:false}}});
 assert.deepEqual(event.changes,[{field:'enabled',before:'true',after:'false'}]);assert.match(event.actor,/not recorded/);
});
