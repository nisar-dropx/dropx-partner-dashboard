import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function fixture({permissions=['ops_rostering','ops_reports'],readOnly=false,locations=[{id:'allowed',station_code:'STORE'}]}={}) {
  const calls=[];
  const auth={companyId:'company',locationScopeIds:['allowed'],hasAllLocationAccess:false,readOnly};
  const mocks={
    '@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:(_,code)=>permissions.includes(code)},
    '@/lib/company-scope':{requireCompanyId:()=>auth.companyId},
    '@/lib/ops-pulse/cod':{loadCodLocations:async(...args)=>{calls.push(['scope',...args]);return {locations,error:null}}},
    '@/lib/ops-pulse/station-manpower':{loadOpsStationManpower:async(...args)=>{calls.push(['people',...args]);return {people:[]}}},
    '@/lib/shift-attendance-export':{shiftAttendanceWorkbook:()=>new Uint8Array(),shiftExportResponse:()=>new Response('workbook')}
  };
  const m={exports:{}};
  const source=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports','module',source)(id=>{if(id in mocks)return mocks[id];throw Error(id)},m.exports,m);
  return {calls,get:(location='allowed')=>m.exports.GET(new Request(`https://ops.test/api/ops-pulse/shift-attendance/export?date=2026-10-20&location=${location}`))};
}
test('attendance export uses Rostering and Reports access, without requiring the dashboard menu',async()=>{
  const f=fixture();assert.equal((await f.get()).status,200);
  assert.deepEqual(f.calls[0],['scope','company',['allowed'],false]);
  assert.deepEqual(f.calls[1],['people','company',[{id:'allowed',station_code:'STORE'}],'2026-10-20']);
});
test('dashboard access alone, missing report access, and preview mode cannot export attendance',async()=>{
  for(const options of [{permissions:['ops_pulse','ops_reports']},{permissions:['ops_rostering']},{readOnly:true}]){
    const f=fixture(options);assert.equal((await f.get()).status,403);assert.equal(f.calls.length,0);
  }
});
test('attendance export cannot read an unassigned location',async()=>{
  const f=fixture();assert.equal((await f.get('outside')).status,403);assert(!f.calls.some(c=>c[0]==='people'));
});
