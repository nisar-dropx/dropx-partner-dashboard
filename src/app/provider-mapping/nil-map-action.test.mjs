import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compiled=ts.transpileModule(readFileSync(new URL('./actions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function action(options={}) {
  const calls=[];
  const auth={userId:'trusted-actor',companyId:'trusted-company',roleCode:'EDITOR',locationScopeIds:['station'],hasAllLocationAccess:false};
  const modules={
    '@/lib/authorization':{getAuthorization:async()=>options.signedOut?null:auth},
    '@/lib/company-scope':{requireCompanyId:a=>a.companyId},
    '@/lib/provider-mapping-access':{canEditProviderMappings:()=>!options.denied},
    '@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return {data:{nil_mapped:true},error:options.failure?{message:'Changed link'}:null};}}},
    'next/cache':{revalidatePath(){},revalidateTag(){}}
  };
  const module={exports:{}};
  new Function('require','module','exports',compiled)(name=>modules[name]??{},module,module.exports);
  const form=(overrides={})=>{
    const data=new FormData();data.set('row_count','1');
    for(const [key,value] of Object.entries({client_key:'member-key',nil_map_action:'mark',id:'',mapping_id:'',provider_id:'provider',station_id:'station',provider_member_id:'MEMBER01',...overrides}))data.set(`rows[0][${key}]`,value);
    return data;
  };
  return {save:module.exports.saveProviderFirstMappingsInline,calls,form};
}
test('Nill Map action derives company and actor from session without asking for a worker',async()=>{
  const a=action();const result=await a.save(a.form());
  assert.equal(result.ok,true,result.message);assert.equal(result.savedRows[0].nilMapped,true);
  assert.deepEqual(a.calls,[{name:'provider_set_member_nil_map',args:{p_company:'trusted-company',p_actor:'trusted-actor',p_provider:'provider',p_station:'station',p_member:'MEMBER01',p_nil:true,p_locations:['station']}}]);
});
test('Nill Map authorization rejects viewers, outside locations and mixed linked identities',async()=>{
  for(const [options,overrides] of [[{signedOut:true},{}],[{denied:true},{}],[{},{station_id:'outside'}],[{},{id:'existing-worker'}],[{},{mapping_id:'existing-map'}],[{},{nil_map_action:'unexpected'}]]) {
    const a=action(options);assert.equal((await a.save(a.form(overrides))).ok,false);assert.equal(a.calls.length,0);
  }
});
test('clearing uses the same scoped server action, while DB failures do not acknowledge a save',async()=>{
  const a=action();const cleared=await a.save(a.form({nil_map_action:'clear'}));
  assert.equal(cleared.savedRows[0].nilMapped,false);assert.equal(a.calls[0].args.p_nil,false);
  const b=action({failure:true});const failed=await b.save(b.form());assert.equal(failed.ok,false);assert.equal(failed.savedRows.length,0);
});
