import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function fixture(){
 const rows=new Map();let error=null;
 const key=r=>JSON.stringify([r.company_id,r.location_id,r.business_date,r.cache_key]);
 const db={from(table){
  assert.equal(table,'report_bot_cod_route_cache');
  return {
   async upsert(row){
    if(row.payload===null)return {error:{message:'payload violates not-null constraint'}};
    if(!error)rows.set(key(row),row);return {error};
   },
   delete(){const scope={};return {
    eq(column,value){scope[column]=value;return this;},
    then(resolve){
     assert.deepEqual(Object.keys(scope).sort(),['business_date','cache_key','company_id','location_id']);
     if(!error)rows.delete(key(scope));return Promise.resolve({error}).then(resolve);
    }
   };}
  };
 }};
 const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(new URL('./lm-cod-journeys.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(name=>name==='./settings'?{reportBotDb:()=>db}:{},module,module.exports);
 return {put:module.exports.codCachePut,rows,fail:()=>{error={message:'database unavailable'}}};
}
test('clearing completed COD or scrub state is idempotent and isolated by tenant, station, date and key',async()=>{
 const {put,rows}=fixture();
 const scopes=[['C','GNTI','2026-11-13','quiet:bank'],['OTHER','GNTI','2026-11-13','quiet:bank'],['C','GNTF','2026-11-13','quiet:bank'],['C','GNTI','2026-11-12','quiet:bank'],['C','GNTI','2026-11-13','quiet:recon']];
 for(const scope of scopes)await put(...scope,{sentAt:123});
 await put(...scopes[0],null);await put(...scopes[0],null);
 assert.equal(rows.size,4);
 for(const scope of scopes.slice(1))assert.ok(rows.has(JSON.stringify(scope)));
 // After clearing bank state, pending reconciliation can still be persisted.
 await put(...scopes[4],{sentAt:456});
 assert.deepEqual(rows.get(JSON.stringify(scopes[4])).payload,{sentAt:456});
});
test('cache writes preserve false/zero and surface persistence failures',async()=>{
 const {put,rows,fail}=fixture();
 await put('C','GNTI','2026-11-13','closure',0);
 assert.equal([...rows.values()][0].payload,0);
 fail();
 await assert.rejects(put('C','GNTI','2026-11-13','closure',null),/database unavailable/);
 await assert.rejects(put('C','GNTI','2026-11-13','closure',{}),/database unavailable/);
});
