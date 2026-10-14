import test from 'node:test';
import assert from 'node:assert/strict';
import {baseStations,latestPublications,monthValue,previousMonth,monthEnd,csvCell} from './model.ts';
test('XPT and nested XPT follow master parents and retain portal aliases',()=>{
 const stations=[{id:'b',station_code:'BASE',parent_station_id:null},{id:'x',station_code:'XPT',parent_station_id:'b'},{id:'y',station_code:'XPT2',parent_station_id:'x'}];
 assert.deepEqual(baseStations(stations,[{location_id:'x',portal_station_code:'AMAZON-X'}])[1],{code:'XPT',base:'BASE',aliases:['AMAZON-X']});assert.equal(baseStations(stations,[])[2].base,'BASE');assert.throws(()=>baseStations([{id:'b',station_code:'B',parent_station_id:'b'}],[]),/cycle/);
});
test('latest publication revisions replace previous amounts within a person/station/period only',()=>{
 const base={workforce_id:'p',station_id:'s',period_start:'2026-09-01',period_end:'2026-09-30'};const list=latestPublications([{...base,id:'old',revision:1},{...base,id:'new',revision:2},{...base,station_id:'s2',id:'other',revision:1}],'workforce_id');assert.deepEqual(list.map(r=>r.id),['new','other']);
});
test('calendar validation and CSV formula neutralisation',()=>{assert.equal(previousMonth(new Date('2026-01-12')),'2025-12');assert.equal(monthEnd('2024-02'),'2024-02-29');assert.throws(()=>monthValue('2026-13'));assert.equal(csvCell('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"');});
