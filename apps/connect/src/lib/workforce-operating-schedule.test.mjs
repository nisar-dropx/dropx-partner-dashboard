import test from 'node:test';import assert from 'node:assert/strict';
import {indiaScheduleToday,scheduleWeekStart,workforceOperatingDays} from './workforce-operating-schedule.ts';
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import ts from 'typescript';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const assignment={id:'first',operating_pincode:'600001',weekly_off_day:0,effective_from:'2026-09-01',effective_to:'2026-09-21'};
test('workforce area and weekly off are resolved per effective day, not today only',()=>{
 const rows=workforceOperatingDays([assignment,{...assignment,id:'second',operating_pincode:'600002',weekly_off_day:2,effective_from:'2026-09-22',effective_to:null}],'2026-09-20',4);
 assert.deepEqual(rows.map(r=>[r.date,r.operatingPincode,r.dayType]),[['2026-09-20','600001','weekly_off'],['2026-09-21','600001','working'],['2026-09-22','600002','weekly_off'],['2026-09-23','600002','working']]);
 assert.ok(rows.every(r=>r.shift===null&&!r.canSwap));
});
test('future-only assignment does not invent a current schedule and overlap fails closed',()=>{
 assert.equal(workforceOperatingDays([{...assignment,effective_from:'2026-09-21'}],'2026-09-20',2).length,1);
 assert.throws(()=>workforceOperatingDays([assignment,{...assignment,id:'duplicate'}],'2026-09-20',1),/conflicting/);
 assert.deepEqual(workforceOperatingDays([],'2026-09-20',30),[]);
});
test('calendar labels use Indian today and UTC date-only Monday boundaries',()=>{
 assert.equal(indiaScheduleToday(new Date('2026-09-20T20:00:00Z')),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-09-21'),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-09-27'),'2026-09-21');
 assert.equal(scheduleWeekStart('2026-01-01'),'2025-12-29');
});
test('unresolved schedule never promises shifts; loaded Workforce and People retain distinct wording',()=>{
 const source=readFileSync(new URL('../components/connect-roster.tsx',import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const require=createRequire(import.meta.url);
 function render(payload){
  const mod={exports:{}};let stateIndex=0;
  const localRequire=name=>{
   if(name==='react')return {...require('react'),useState:initial=>[stateIndex++===0?payload:initial,()=>{}],useEffect:()=>{},useCallback:fn=>fn,useMemo:fn=>fn()};
   if(name==='@/lib/roster-plan-preference')return {formatShiftClock:()=>''};
   if(name==='@/lib/roster-change-deadline')return {rosterChangeDeadlineShortLabel:()=>''};
   if(name==='@/lib/use-keep-alive-refresh')return {useKeepAliveRefresh:()=>({markLoaded:()=>{},setReload:()=>{}})};
   if(name==='../lib/workforce-operating-schedule')return {indiaScheduleToday,scheduleWeekStart};
   return require(name);
  };
  new Function('require','exports',output)(localRequire,mod.exports);
  return renderToStaticMarkup(createElement(mod.exports.ConnectRoster,{account:{id:'test',profileType:'workforce'}}));
 }
 const loading=render(null);assert.match(loading,/>Work plan</);assert.match(loading,/role="status"/);assert.doesNotMatch(loading,/shift times|swap requests/);
 const workforce=render({source:'workforce',viewDays:30,days:[],requests:[],leadHours:0});assert.match(workforce,/>Operating schedule</);assert.match(workforce,/operating pincode and weekly off/);assert.doesNotMatch(workforce,/shift times|swap requests/);
 const people=render({viewDays:7,days:[],requests:[],leadHours:0});assert.match(people,/>Roster</);assert.match(people,/shift times and swap requests/);
});
