import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as core from './lm-dispatch-mentions-core.ts';

function fixture(hasCluster) {
  const queried=[];
  const db={from(table){const q={table,ids:[],select(){return q},eq(){return q},is(){return q},not(){return q},in(_key,ids){q.ids=ids;return q},order(){return q}};return q}};
  const deps={
    'server-only':{},
    '@/lib/supabase-admin':{supabaseAdmin:db},
    '@/lib/supabase-pagination':{readAllRows:async q=>{queried.push(q.ids);return {data:q.ids.map(id=>({id,email:id+'@example.test'})),error:null}}},
    '@/lib/people-operational-hierarchy':{loadPeopleOperationalHierarchy:async()=>({byLocation:new Map([['S1',{clusterManagers:hasCluster?[{personId:'CLM'}]:[],areaOperationsManagers:[{personId:'AOM'}]}]]),error:null})},
    '@/lib/ops-pulse/cod-station-team':{loadCodTeamDirectory:async(_company,locations,managerIds)=>{
      assert.deepEqual(locations,['S1']);
      assert.deepEqual(managerIds,[hasCluster?'CLM':'AOM']);
      return [{personId:'TL',workerId:'TL',workerType:'employee',role:'Team Leader',roleCode:'TL',locationId:'S1',phone:'9000000001'},...managerIds.map(id=>({personId:id,workerId:id,workerType:'employee',roleCode:id,locationId:'HO',phone:id==='CLM'?'9000000002':'9000000003'}))];
    }},
    './lm-dispatch-mentions-core':core,
  };
  const module={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(new URL('./lm-dispatch-mentions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(key=>deps[key],module,module.exports);
  return {resolve:module.exports.resolveBankReminderMentions,queried};
}
for(const hasCluster of [true,false]) test(hasCluster?'CLM email takes precedence over AOM':'unmapped CLM falls back to station AOM email and tag',async()=>{
  const {resolve,queried}=fixture(hasCluster);
  const result=await resolve('C',[{id:'S1',station_code:'TEST'}],{mention_manager_policy:'cluster_then_aom',mention_designation_codes:['TL','CT'],mentions:['919000000004']},'2026-11-12');
  assert.deepEqual(result.managerEmails,[hasCluster?'clm@example.test':'aom@example.test']);
  assert.deepEqual(queried,[[hasCluster?'CLM':'AOM']]);
  assert.deepEqual(result.cluster,hasCluster?['919000000002']:[]);
  assert.deepEqual(result.aom,hasCluster?[]:['919000000003']);
  assert.deepEqual(result.tl,['919000000001']);
});
