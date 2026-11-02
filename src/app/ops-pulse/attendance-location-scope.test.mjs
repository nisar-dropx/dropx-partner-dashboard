import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';

const amazon={id:'amazon',station_code:'KLZA'};
const flipkart={id:'flipkart',station_code:'FK01'};
const office={id:'office',station_code:'HO',is_ho:true};
const store={id:'store',station_code:'DS01'};
const walk=(node,predicate)=>{
 if(!node||typeof node!=='object')return [];
 return [...(predicate(node)?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(child=>walk(child,predicate))];
};
async function render(allowed,requested,all=false){
 const auth={locationScopeIds:allowed.map(l=>l.id),hasAllLocationAccess:all};
 const loaded=[];
 const deps={
  react:React,'react/jsx-runtime':await import('react/jsx-runtime'),
  'next/link':{__esModule:true,default:'a'},'next/navigation':{redirect:()=>{throw Error('unexpected redirect');}},
  '@/lib/authorization':{requirePagePermission:async()=>auth,hasPermission:()=>true},
  '@/lib/company-scope':{requireCompanyId:()=> 'company'},
  '@/lib/ops-pulse/cod':{todayKolkata:()=> '2026-11-02',loadCodLocations:async(company,ids,hasAll)=>{
   assert.equal(company,'company');assert.deepEqual(ids,auth.locationScopeIds);assert.equal(hasAll,all);
   return {locations:allowed,error:null};
  }},
  '@/lib/ops-pulse/operating-context':{resolveOperatingContext:()=>({mode:'amazon_edsp',availableModes:allowed.includes(amazon)?['amazon_edsp']:[],modeLocations:allowed.filter(l=>l===amazon),selectedLocations:allowed.filter(l=>l===amazon)})},
  '@/lib/ops-pulse/cps':{isoDate:()=>true},
  '@/lib/ops-pulse/station-manpower':{loadOpsStationManpower:async(company,locations)=>{loaded.push(...locations);return {asOf:'2026-11-02',people:[]};}},
 };
 const output=ts.transpileModule(fs.readFileSync(new URL('./page.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 new Function('require','exports','module',output)(name=>deps[name]??new Proxy({},{get:(_,key)=>key}),module.exports,module);
 const page=await module.exports.default({searchParams:{view:'manpower',location:requested}});
 const content=walk(page,n=>typeof n.type==='function'&&n.type.name==='Manpower')[0];
 const rendered=await content.type(content.props);
 return {ids:walk(rendered,n=>n.type==='option').map(n=>n.props.value),loaded:loaded.map(l=>l.id)};
}
test('attendance includes authorised Amazon, Flipkart, HO and dark stores regardless of operating mode',async()=>{
 assert.deepEqual(await render([amazon,flipkart,office,store],'flipkart',true),{ids:['amazon','flipkart','office','store'],loaded:['flipkart']});
});
test('a two-location user sees only their permitted locations, including HO',async()=>{
 assert.deepEqual(await render([flipkart,office],'office'),{ids:['flipkart','office'],loaded:['office']});
});
test('a crafted location URL cannot load attendance outside the authorised list',async()=>{
 assert.deepEqual(await render([amazon,flipkart],'office'),{ids:['amazon','flipkart'],loaded:['amazon']});
});
test('HO-only users get their office even without an operational mode',async()=>{
 assert.deepEqual(await render([office]),{ids:['office'],loaded:['office']});
});
test('empty access never loads a location',async()=>{
 assert.deepEqual(await render([],'office'),{ids:[],loaded:[]});
});
