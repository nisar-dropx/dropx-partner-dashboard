import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
test('COD locations use explicit People station responsibility and keep permitted station scope',async()=>{
 const calls=[];
 const dependencies={
  react:{cache:fn=>fn},
  '@/lib/supabase-admin':{supabaseAdmin:{from:()=>({select(){return this;},eq(){return this;},async order(){return{data:[{id:'xpt',station_code:'XPT',cluster_manager:'Obsolete'},{id:'outside',station_code:'OUT'}],error:null};}})}},
  '@/lib/people-operational-hierarchy':{loadPeopleOperationalHierarchy:async(company,ids,options)=>{calls.push({company,ids,options});return{error:null,byLocation:new Map([['xpt',{clusterManagers:options?.includeStationResponsibilities?[{name:'Current People CM'}]:[],areaOperationsManagers:[]}]])};}},
  '@/lib/date-format':{},
  '@/lib/ops-pulse/date-format':{formatOpsDate:v=>v??'-',formatOpsDateTime:v=>v??'-'},
  '@/lib/ops-pulse/capacity-shipments':{}
 };
 const output=ts.transpileModule(fs.readFileSync(new URL('./cod.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};new Function('require','exports','module',output)(name=>dependencies[name],module.exports,module);
 const result=await module.exports.loadCodLocations('company',['xpt'],false);
 assert.equal(result.locations.length,1);assert.equal(result.locations[0].cluster_manager,'Current People CM');assert.deepEqual(result.locations[0].cluster_manager_names,['Current People CM']);
 assert.equal(calls[0].options.includeStationResponsibilities,true);
});
