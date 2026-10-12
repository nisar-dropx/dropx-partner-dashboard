import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { assertPickupScope, parsePickupFields, parsePickupAdvanced } from '../../../lib/ops-pulse/cod-pickup.ts';

function actions({record={location_id:'A',updated_at:'v1'},allowed=true,resultRows=[{id:'row'}]}={}) {
 const calls=[], flashes=[];
 const db={from(table){const q={};for(const op of ['select','eq','update','insert']) q[op]=(...args)=>{calls.push([op,...args]);return q;};q.maybeSingle=async()=>({data:record,error:null});q.then=resolve=>resolve({data:resultRows,error:null});return q;}};
 const deps={
  'next/headers':{cookies:()=>({set:(_k,v)=>flashes.push(JSON.parse(v))})},
  'next/cache':{revalidatePath:()=>{}},
  'next/navigation':{redirect:()=>{throw Object.assign(new Error('redirect'),{digest:'NEXT_REDIRECT'});}},
  '@/lib/authorization':{requirePagePermission:async()=>{if(!allowed)throw Error('denied');return {companyId:'tenant',userId:'user',hasAllLocationAccess:false,locationScopeIds:['A']};}},
  '@/lib/company-scope':{requireCompanyId:auth=>auth.companyId},
  '@/lib/supabase-admin':{supabaseAdmin:db},
  '@/lib/ops-pulse/cod-pickup':{assertPickupScope,parsePickupFields,parsePickupAdvanced}
 };
 const out=ts.transpileModule(fs.readFileSync(new URL('./actions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};new Function('require','exports','module',out)(n=>deps[n],module.exports,module);
 return {...module.exports,calls,flashes};
}
function form(){const f=new FormData();for(const [k,v] of Object.entries({id:'row',location_id:'A',updated_at:'v1',cms_agency:'Radiant',pickup_rule:'Next Day',pickup_window_start:'08:00',pickup_window_end:'08:30'}))f.set(k,v);return f;}
test('edit and delete check the stored station, not the client station',async()=>{for(const method of ['updateCodMaster','deleteCodMaster']){const a=actions({record:{location_id:'B'}});await assert.rejects(a[method](form()));assert.equal(a.calls.filter(c=>c[0]==='update').length,0);assert.match(a.flashes[0].error,/access/);}});
test('no permission means no database operation',async()=>{const a=actions({allowed:false});await assert.rejects(a.deleteCodMaster(form()));assert.equal(a.calls.length,0);});
test('delete is recoverable, scoped and protects concurrent edits',async()=>{const a=actions();await assert.rejects(a.deleteCodMaster(form()));const update=a.calls.find(c=>c[0]==='update')[1];assert.equal(update.pickup_configured,false);assert.equal(update.pickup_rule,undefined);assert.ok(a.calls.some(c=>c[0]==='eq'&&c[1]==='company_id'&&c[2]==='tenant'));assert.ok(a.calls.some(c=>c[1]==='updated_at'&&c[2]==='v1'));});
test('concurrent edit does not claim success',async()=>{const a=actions({resultRows:[]});await assert.rejects(a.updateCodMaster(form()));assert.match(a.flashes[0].error,/Someone changed/);});
