import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function fixture(mode,permissions,availableModes=[mode]) {
  const calls=[];
  const auth={companyId:'company',locationScopeIds:['assigned'],hasAllLocationAccess:false};
  const assigned=[{id:'assigned',station_code:'STORE'}];
  const jsx=(type,props)=>({type,props});
  const mocks={
    'react/jsx-runtime':{jsx,jsxs:jsx},'react':{Suspense:'suspense'},
    'next/navigation':{redirect:url=>{throw Error('redirect:'+url)}},
    '@/components/app-shell':{AppShell:'shell'},
    '@/lib/authorization':{requirePagePermission:async(code)=>{calls.push(['permission',code]);if(!permissions.includes(code))throw Error('denied');return auth}},
    '@/lib/company-scope':{requireCompanyId:()=>auth.companyId},
    '@/lib/ops-pulse/cod':{loadCodLocations:async(...args)=>{calls.push(['locations',...args]);return {locations:assigned,error:null}}},
    '@/lib/ops-pulse/operating-context':{resolveOperatingContext:()=>({mode,selectedLocations:assigned,modeLocations:assigned,availableModes})}
  };
  const m={exports:{}};
  const source=ts.transpileModule(readFileSync(new URL('./page.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','exports','module',source)(id=>mocks[id]??{},m.exports,m);
  return {calls,open:searchParams=>m.exports.default({searchParams})};
}
test('LM and DS attendance entries require roster access and retain assigned location scope',async()=>{
  for(const mode of ['amazon_edsp','amazon_now']){
    const f=fixture(mode,['ops_rostering']);const page=await f.open({view:'manpower'});
    assert.equal(page.props.pageCode,'ops_rostering');assert.equal(page.props.active,'Shift Attendance');
    assert.equal(page.props.children.props.children.type.name,'Manpower');
    assert.deepEqual(f.calls,[['permission','ops_rostering'],['locations','company',['assigned'],false]]);
  }
});
test('dashboard access does not authorize attendance, and roster access does not authorize the dashboard',async()=>{
  const homeOnly=fixture('amazon_now',['ops_pulse']);await assert.rejects(homeOnly.open({view:'manpower'}),/denied/);assert.equal(homeOnly.calls.length,1);
  const rosterOnly=fixture('amazon_now',['ops_rostering']);await assert.rejects(rosterOnly.open({}),/denied/);assert.equal(rosterOnly.calls.length,1);
});

test("an account with no operating locations gets a generic access screen, never Last Mile cards",async()=>{
 const f=fixture("amazon_edsp",["ops_pulse"],[]);
 await assert.rejects(f.open({}),/redirect:\/unauthorized\?page=ops_portal&reason=location/);
});
