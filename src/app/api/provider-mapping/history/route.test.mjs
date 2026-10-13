import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as audit from '../../../../lib/provider-mapping-audit.ts';
const require=createRequire(import.meta.url);
const compiled=ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const id='00000000-0000-4000-8000-000000000001';
async function call(auth,permission=true,station='permitted'){
 const mapping={id,company_id:'company',station_id:station,workforce_id:'worker',provider_id:'provider',provider_member_id:'111',effective_from:'2026-10-01',created_by:'actor',created_at:'2026-10-13T14:00:00Z',updated_at:'2026-10-13T14:00:00Z'};
 const rows={field_executive_provider_mappings:[mapping],workforce_joining_events:[],profiles:[{id:'actor',company_id:'company',full_name:'Real Editor'}]};
 const admin={from(table){let data=rows[table];return{select(){return this},eq(k,v){data=data.filter(r=>r[k]===v);return this},in(k,v){data=data.filter(r=>v.includes(r[k]));return this},like(){return this},order(){return this},then(resolve){return Promise.resolve({data,error:null}).then(resolve)}}}};
 const deps={'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},'@/lib/authorization':{getAuthorization:async()=>auth,hasPermission:()=>permission},'@/lib/provider-mapping-access':{currentProviderMappingPageCode:()=> 'ops_provider_mapping'},'@/lib/supabase-admin':{supabaseAdmin:admin},'@/lib/supabase-pagination':{readAllRows:async query=>await query},'@/lib/provider-mapping-audit':audit};
 const module={exports:{}};new Function('require','exports','module',compiled)(key=>deps[key]??require(key),module.exports,module);
 return module.exports.GET(new Request('https://ops.example/api/provider-mapping/history?ids='+id));
}
test('history rejects unsigned, unauthorized and out-of-scope requests',async()=>{
 const auth={companyId:'company',locationScopeIds:['permitted']};
 assert.equal((await call(null)).status,401);
 assert.equal((await call(auth,false)).status,403);
 assert.equal((await call(auth,true,'other')).status,403);
 const valid=await call(auth);assert.equal(valid.status,200);assert.equal(valid.body.audit[id][0].actor,'Real Editor');assert.equal(valid.headers['Cache-Control'],'private, no-store');
});
