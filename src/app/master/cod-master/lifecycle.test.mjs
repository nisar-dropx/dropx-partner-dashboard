import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as pickup from '../../../lib/ops-pulse/cod-pickup.ts';

// Exercise the server actions through their database boundary without changing live station policy.
function system() {
 const records={stations:[{id:'station-a',company_id:'company',station_code:'AAA',state:'AP',is_active:true}],cod_station_settings:[]};
 const auth={userId:'editor',hasAllLocationAccess:false,locationScopeIds:['station-a']};
 const notices=[],invalidated=[];
 const db={from(table){
  let operation='read',payload,filters=[];
  const execute=()=>{
   const rows=records[table].filter(row=>filters.every(([key,value])=>row[key]===value));
   if(operation==='insert'){const row={id:'setting-a',updated_at:'initial',...payload};records[table].push(row);return{data:[row],error:null};}
   if(operation==='update') for(const row of rows) Object.assign(row,payload);
   return {data:structuredClone(rows),error:null};
  };
  const builder={select(){return builder;},eq(key,value){filters.push([key,value]);return builder;},update(value){operation='update';payload=value;return builder;},insert(value){operation='insert';payload=value;return builder;},async maybeSingle(){const x=execute();return{...x,data:x.data[0]||null};},then(resolve,reject){return Promise.resolve(execute()).then(resolve,reject);}};
  return builder;
 }};
 const dependencies={
  'next/headers':{cookies:()=>({set:(_key,value)=>notices.push(JSON.parse(value))})},
  'next/cache':{revalidatePath:path=>invalidated.push(path)},
  'next/navigation':{redirect:()=>{throw Object.assign(new Error('Redirect'),{digest:'NEXT_REDIRECT;'});}},
  '@/lib/authorization':{requirePagePermission:async()=>auth},
  '@/lib/company-scope':{requireCompanyId:()=> 'company'},
  '@/lib/supabase-admin':{supabaseAdmin:db},
  '@/lib/ops-pulse/cod-pickup':pickup,
 };
 const code=ts.transpileModule(fs.readFileSync(new URL('./actions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};new Function('require','module','exports',code)(key=>dependencies[key],module,module.exports);
 async function act(name,values){const form=new FormData();for(const [key,value] of Object.entries(values))form.set(key,String(value));await assert.rejects(module.exports[name](form),error=>error.digest==='NEXT_REDIRECT;');return notices.at(-1);}
 return {records,auth,invalidated,act};
}
const basic={location_id:'station-a',cms_agency:'Radiant',pickup_rule:'Same Day-Partial',pickup_window_start:'18:00',pickup_window_end:'18:30',...pickup.pickupDefaults};

test('add → master policy → edit → remove → restore keeps history and integration settings',async()=>{
 const s=system();assert.match((await s.act('createCodMaster',basic)).notice,/saved/);
 const row=s.records.cod_station_settings[0];
 assert.equal(row.station_code,'AAA');assert.equal(row.state,'AP');assert.equal(row.portal_station_code,'AAA');
 assert.equal(pickup.pickupPolicy(row).rule,'Same Day-Partial');assert.equal(row.driver_recon_due_time,'21:00');
 assert.match((await s.act('createCodMaster',basic)).error,/already configured/);
 Object.assign(row,{portal_checks_enabled:true,portal_check_interval_minutes:20,escalation_email:'ops@example.com',portal_secret_name:'retained-reference'});
 const edit={...basic,id:row.id,updated_at:row.updated_at,pickup_rule:'Next Day',pickup_window_start:'10:00',pickup_window_end:'10:30'};
 assert.match((await s.act('updateCodMaster',edit)).notice,/updated/);
 assert.equal(pickup.pickupPolicy(row).preparationFrom,'16:00');assert.equal(row.portal_check_interval_minutes,20);
 assert.match((await s.act('deleteCodMaster',{id:row.id,updated_at:row.updated_at})).notice,/deleted/);
 assert.equal(pickup.pickupPolicy(row),null);assert.equal(row.portal_secret_name,'retained-reference');
 assert.match((await s.act('createCodMaster',basic)).notice,/saved/);
 assert.equal(s.records.cod_station_settings.length,1);assert.equal(row.portal_checks_enabled,true);assert.equal(row.escalation_email,'ops@example.com');
 assert.ok(s.invalidated.includes('/cod/status'));assert.ok(s.invalidated.includes('/master/cod-master'));
});

test('stale edits/deletes and out-of-scope station writes do not change saved rules',async()=>{
 const s=system();await s.act('createCodMaster',basic);const row=s.records.cod_station_settings[0];
 const before=structuredClone(row);
 assert.match((await s.act('updateCodMaster',{...basic,id:row.id,updated_at:'outdated'})).error,/Someone changed/);
 assert.match((await s.act('deleteCodMaster',{id:row.id,updated_at:'outdated'})).error,/Someone changed/);
 s.auth.locationScopeIds=[];
 assert.match((await s.act('updateCodMaster',{...basic,id:row.id,updated_at:row.updated_at})).error,/access/);
 assert.match((await s.act('deleteCodMaster',{id:row.id,updated_at:row.updated_at})).error,/access/);
 assert.deepEqual(row,before);
});

test('contact edits preserve estimated provenance; changing a window makes it a manual schedule',async()=>{
 const s=system();await s.act('createCodMaster',basic);const row=s.records.cod_station_settings[0];
 row.pickup_window_basis='Estimated from remittance updates';
 await s.act('updateCodMaster',{...basic,id:row.id,updated_at:row.updated_at,agent_name:'CMS agent'});
 assert.equal(row.pickup_window_basis,'Estimated from remittance updates');
 await s.act('updateCodMaster',{...basic,id:row.id,updated_at:row.updated_at,pickup_window_end:'19:00'});
 assert.equal(row.pickup_window_basis,null);
});

test('master persists station-specific remittance tolerance and rejects bad/stale overrides',async()=>{
 const s=system();await s.act('createCodMaster',basic);const row=s.records.cod_station_settings[0];
 assert.equal(row.remittance_variance_tolerance,5);
 await s.act('updateCodMaster',{...basic,id:row.id,updated_at:row.updated_at,remittance_variance_tolerance:'1.25'});
 assert.equal(row.remittance_variance_tolerance,1.25);
 assert.match((await s.act('updateCodMaster',{...basic,id:row.id,updated_at:row.updated_at,remittance_variance_tolerance:'-5'})).error,/variance tolerance/);
 assert.equal(row.remittance_variance_tolerance,1.25);
 assert.match((await s.act('updateCodMaster',{...basic,id:row.id,updated_at:'old',remittance_variance_tolerance:0})).error,/Someone changed/);
 assert.equal(row.remittance_variance_tolerance,1.25);
});
