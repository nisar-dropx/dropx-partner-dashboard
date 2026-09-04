import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const root=new URL('./',import.meta.url);
function compile(url,aliases){
  const module={exports:{}};
  const code=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports','module',code)(name=>name in aliases?aliases[name]:require(name),module.exports,module);
  return module.exports;
}
const pure=compile(new URL('../../../lib/ops-pulse/station-review-targets.ts',root),{});
const hawkeye=compile(new URL('../../../lib/ops-pulse/hawkeye.ts',root),{});
function fixture({scope=true,allowed=true,affected=true}={}){
  const calls=[],saved=[];
  const current={id:'target',metricKey:'afn_premium_dot',reportType:'daily',sourceIndex:5,target:.955,direction:'higher',weight:0,label:'Original',short:'Original',isActive:true,displayOrder:5,unit:'percent'};
  const builder={};
  for(const method of ['update','insert','eq','neq'])builder[method]=(...args)=>{calls.push([method,...args]);return builder;};
  builder.select=async()=>({data:affected?[{id:'setting'}]:[],error:null});
  const actions=compile(new URL('actions.ts',root),{
    'next/cache':{revalidatePath(){}},
    'next/navigation':{redirect(url){throw new Error(url);}},
    '@/lib/authorization':{async requirePagePermission(code,operation){assert.equal(code,'performance_master');assert.equal(operation,'edit');if(!allowed)throw Error('denied');return {userId:'actor',locationScopeIds:['station'],hasAllLocationAccess:false};}},
    '@/lib/company-scope':{requireCompanyId:()=> 'company'},
    '@/lib/supabase-admin':{supabaseAdmin:{from:(table)=>{assert.equal(table,'report_import_master');return builder;}}},
    '@/lib/ops-pulse/cod':{loadCodLocations:async()=>({locations:scope?[{id:'station'}]:[],error:null})},
    '@/lib/ops-pulse/station-review-targets':pure,
    '@/lib/ops-pulse/station-review-targets-data':{stationTargetCode:id=>'perf_station_review_'+id},
    '@/lib/ops-pulse/hawkeye':hawkeye,
    '@/lib/ops-pulse/performance-targets':{loadPerformanceTargets:async()=>({rows:[current],error:null}),savePerformanceTarget:async(...args)=>{saved.push(args);return null;},createPerformanceTarget:async(...args)=>{saved.push(args);return null;}}
  });
  return {actions,calls,saved,current};
}
const form=values=>{const data=new FormData();Object.entries(values).forEach(([key,value])=>data.set(key,value));return data;};
test('station target save is company/station/version scoped and does not update opening windows',async()=>{
  const f=fixture();
  await assert.rejects(f.actions.updateStationReviewTargets(form({station_id:'station',version:'original',clearance_cutoff:'08:30',emd_noon_target:'95'})),/targets_saved=1/);
  for(const pair of [['company_id','company'],['source_code','perf_station_review_station'],['updated_at','original']])assert.ok(f.calls.some(([method,...args])=>method==='eq'&&JSON.stringify(args)===JSON.stringify(pair)));
  const update=f.calls.find(row=>row[0]==='update')[1];
  assert.deepEqual(JSON.parse(update.description),{clearanceCutoff:'08:30',emdNoonTarget:95,updatedBy:'actor'});
  assert.ok(!('opening_window_start' in update));
});
test('no station access or invalid targets cannot write',async()=>{
  for(const [options,emd] of [[{scope:false},'90'],[{allowed:false},'90'],[{},'101']]){
    const f=fixture(options);
    await assert.rejects(f.actions.updateStationReviewTargets(form({station_id:'station',emd_noon_target:emd})));
    assert.equal(f.calls.length,0);
  }
});
test('concurrent update reports refresh instead of success',async()=>{
  const f=fixture({affected:false});
  await assert.rejects(f.actions.updateStationReviewTargets(form({station_id:'station',version:'stale',emd_noon_target:'95'})),/error=/);
});
test('metric target save preserves mapping and other configuration; percent converts once',async()=>{
  const f=fixture();
  await assert.rejects(f.actions.updateReviewMetricTarget(form({metric_key:'afn_premium_dot',target_pct:'96.5',direction:'higher'})),/targets_saved=1/);
  assert.deepEqual(f.saved[0],['company','target',{...f.current,target:.965,explicitReviewTarget:true}]);
});
test('blank metric target is explicitly informational, not an accidental fallback',async()=>{
  const f=fixture();
  await assert.rejects(f.actions.updateReviewMetricTarget(form({metric_key:'afn_premium_dot',target_pct:'',direction:'higher'})),/targets_saved=1/);
  assert.equal(f.saved[0][2].target,null);assert.equal(f.saved[0][2].explicitReviewTarget,true);
});
