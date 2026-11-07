const assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs');
let auth,station,provider,rpcResult,calls;
const company='company',location='00000000-0000-0000-0000-000000000001';
const admin={from(){const q={select(){return q},eq(){return q},async maybeSingle(){return station},async single(){return provider}};return q},async rpc(name,args){calls.push({name,args});return rpcResult}};
const m={exports:{}};const code=ts.transpileModule(fs.readFileSync('src/app/api/payments/adhoc-das/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',code)(name=> name.endsWith('/authorization')?{getAuthorization:async()=>auth,hasPermission:(context,page,action)=>{
 if(context.readOnly && ['add','edit'].includes(action))return false;
 const p=context.permissions[page]??{};
 return action==='access'?Boolean(p.canView||p.canAdd||p.canEdit):Boolean(p[action==='add'?'canAdd':action==='edit'?'canEdit':'canView']);
}}:name.endsWith('/company-scope')?{requireCompanyId:()=>company}:{supabaseAdmin:admin},m,m.exports);
function fixture(){auth={permissions:{payment_requests:{canAdd:true}},hasAllLocationAccess:false,locationScopeIds:[location],email:'test@example.invalid'};station={data:{station_code:'BASE'},error:null};provider={data:{providers:{code:'AMAZON',name:'Amazon'}},error:null};rpcResult={data:[{provider_member_id:'0000123',workforce_name:'Test DA',dropx_id:'T1005',station_codes:['BASE','XPT'],shipment_id:'shipment'}],error:null};calls=[];}
const get=(query=`location=${location}&strict=1&family=1&date=2026-11-06`)=>m.exports.GET(new Request(`https://example.invalid/api/payments/adhoc-das?${query}`));
(async()=>{
 fixture();let response=await get();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(calls,[{name:'payment_delivery_identity_roster_v2',args:{p_company_id:company,p_station_id:location,p_work_date:'2026-11-06'}}]);let body=await response.json();assert.equal(body.options[0].value,'0000123');assert.equal(body.options[0].helper,'BASE / XPT');assert.match(body.options[0].label,/Test DA.*T1005.*0000123/);
 for(const date of ['2026-02-30','2026-13-01','invalid','']){fixture();assert.equal((await get(`location=${location}&strict=1&family=1&date=${date}`)).status,400);assert.equal(calls.length,0)}
 fixture();auth.locationScopeIds=[];assert.equal((await get()).status,403);assert.equal(calls.length,0);
 fixture();auth.permissions={};assert.equal((await get()).status,403);assert.equal(calls.length,0);
 fixture();auth=null;assert.equal((await get()).status,403);assert.equal(calls.length,0);
 // The station Expense Requests flow and read-only View as user preview must
 // resolve the same roster without granting payment mutation permissions.
 for(const page of ['expense_requests','payment_requests'])for(const permission of ['canView','canAdd','canEdit'])for(const readOnly of [false,true]){
  fixture();auth.permissions={[page]:{[permission]:true}};auth.readOnly=readOnly;
  response=await get();assert.equal(response.status,200,`${page}/${permission}/preview=${readOnly}`);
  assert.equal((await response.json()).options[0].value,'0000123');
  fixture();auth.permissions={[page]:{[permission]:true}};auth.readOnly=readOnly;auth.locationScopeIds=[];
  assert.equal((await get()).status,403);assert.equal(calls.length,0);
 }
 fixture();auth.permissions={expense_requests:{canAdd:true}};response=await get(`location=${location}`);assert.equal(response.status,200);assert.equal(calls[0].name,'payment_adhoc_da_roster');
 fixture();auth.locationScopeIds=[];station.data.station_email='TEST@example.invalid';assert.equal((await get()).status,200);
 fixture();rpcResult.error={message:'db failure'};assert.equal((await get()).status,503);
 fixture();response=await get(`location=${location}&strict=1&date=2026-11-06`);assert.equal(calls[0].name,'payment_delivery_identity_roster');assert.equal((await response.json()).options[0].value,'shipment');
 fixture();response=await get(`location=${location}`);assert.equal(response.status,200);assert.equal(calls[0].name,'payment_adhoc_da_roster');
 console.log('PASS actual roster API: expense-only/payment-only/read-only preview permission matrix, denied unauthenticated/unprivileged/out-of-scope callers, provider-ID options, searchable names/DropX IDs, date validation, retriable errors, legacy callers.');
})().catch(e=>{console.error(e);process.exitCode=1});
