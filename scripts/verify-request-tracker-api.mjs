import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const catalog=JSON.parse(readFileSync('src/lib/request-tracker/catalog.json','utf8'));
const links=JSON.parse(readFileSync('src/lib/request-tracker/links.json','utf8'));
function compile(file,imports){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:id=>{if(!(id in imports))throw Error(id);return imports[id];},console,Date,URL,Set,Map,Response});return exports;}
const model=compile('src/lib/request-tracker/model.ts',{'./catalog.json':catalog});
assert.equal(model.state({status:'paid',approval_status:'FINAL_APPROVED'}),'paid');
assert.equal(model.waiting({status:'paid',approval_status:'FINAL_APPROVED'}),'No active approval recorded');
assert.equal(model.waiting({approval_status:'NO_APPROVER_CONFIGURED'}),'Approver configuration');
assert.equal(model.eventActor({source:'Database change',record:{recorded_actor_id:'someone'}},{}),'Backend / service','row attribution is not forged into authenticated identity');
assert.equal(model.age('invalid'),'—');assert.equal(model.eventTime({source:'steps',record:{created_at:'2026-09-01',decided_at:'2026-09-28'}}),'2026-09-28');
let authorization=null,surface='dashboard',calls=[];
const route=compile('src/app/api/request-tracker/route.ts',{
 'next/server':{NextResponse:{json:(v,o)=>new Response(JSON.stringify(v),o)}},
 '@/lib/authorization':{getAuthorization:async()=>authorization,isCompanyOwner:a=>a.isMasterOwner||a.roleCode==='OWNER'},
 '@/lib/access-surface':{currentAdminAccessSurface:()=>surface},
 '@/lib/request-tracker/model':model,
 '@/lib/request-tracker/links.json':links,
 '@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return {data:null,error:null};}}}
});
const get=(query='')=>route.GET(new Request('https://dashboard.dropxlogistics.com/api/request-tracker'+query));
assert.equal((await get()).status,401);
authorization={companyId:'real-company',roleCode:'MANAGER',permissions:{request_tracker:{canView:true}}};assert.equal((await get()).status,403);assert.equal(calls.length,0);
authorization={...authorization,roleCode:'OWNER'};surface='ops';assert.equal((await get()).status,403);assert.equal(calls.length,0);surface='dashboard';
assert.equal((await get('?type=not-a-source')).status,400);assert.equal((await get('?offset=-1')).status,400);assert.equal((await get('?offset=1.5')).status,400);
const response=await get('?type=payment&id=12345678-1234-1234-1234-123456789abc&company_id=attacker-company');assert.equal(response.status,404);assert.equal(calls[0].args.p_company,'real-company');assert.equal(response.headers.get('cache-control'),'private, no-store');
console.log('Request Tracker API/model checks passed: signed-out/non-owner/cross-portal denial, tenant source, invalid inputs, no-store and terminal-state precedence.');
