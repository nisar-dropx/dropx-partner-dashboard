import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function server(station,settings={}) {
 const calls=[];
 const db={from(table){const filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},async maybeSingle(){calls.push({table,filters});return {data:table==='stations'?station:settings,error:null};}};return q;}};
 const dependencies={
  './cod':{firstRelation:x=>Array.isArray(x)?x[0]:x,loadCodLocations:()=>{throw Error('Full hierarchy must not load for a station refresh');}},
  '@/lib/company-scope':{requireCompanyId:()=> 'tenant'},'@/lib/supabase-admin':{supabaseAdmin:db},
 };
 const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(new URL('./cod-status-server.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','module','exports',code)(k=>dependencies[k],module,module.exports);
 return {...module.exports,calls};
}
const auth={hasAllLocationAccess:false,locationScopeIds:['A']};
const station={id:'A',station_code:'AAA',providers:{code:'AMAZON'},location_models:{code:'AMXL'}};
test('targeted refresh denies another station before reading its configuration',async()=>{
 const s=server(station);assert.equal(await s.loadCodStatusLocation(auth,'B'),null);assert.equal(s.calls.length,0);
 assert.equal((await s.loadCodStatusLocation(auth,'A')).id,'A');
 assert.deepEqual(s.calls[0].filters,[['company_id','tenant'],['id','A'],['is_active',true]]);
});
test('hidden, HO and non-Amazon supported-model lookalikes are excluded for owners too',async()=>{
 for(const row of [{...station,hide_from_location_list:true},{...station,is_ho:true},{...station,providers:{code:'FLIPKART'}},{...station,location_models:{code:'UFC'}}]) {
  const s=server(row);assert.equal(await s.loadCodStatusLocation({...auth,hasAllLocationAccess:true},'A'),null);
 }
});
test('SCC station mapping is tenant-scoped and inactive master rows refuse refresh',async()=>{
 const s=server(station,{portal_station_code:'XAPI',is_active:true});assert.equal(await s.codStatusPortalStation(auth,station),'XAPI');
 assert.deepEqual(s.calls[0].filters,[['company_id','tenant'],['location_id','A']]);
 await assert.rejects(server(station,{is_active:false}).codStatusPortalStation(auth,station),/inactive/);
 assert.equal(await server(station,{}).codStatusPortalStation(auth,station),'AAA');
});
