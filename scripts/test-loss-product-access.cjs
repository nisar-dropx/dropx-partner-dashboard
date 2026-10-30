const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.cwd();let auth,windowEnabled=false,rpcCalls=0,lastRpc;
const db={from(){const q=new Proxy({}, {get(_,k){if(k==='then')return resolve=>resolve({data:[],error:null});return ()=>q;}});return q;},rpc:async(name,args)=>{rpcCalls++;lastRpc=args;return {data:{version:2},error:null};}};
function load(file,extra={}){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(id=>{
 if(id in extra)return extra[id];if(id==='server-only')return{};
 if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:(a,p,act)=>!a.denied};
 if(id.endsWith('/supabase-admin'))return{ supabaseAdmin:db };
 if(id.endsWith('/approval-covers'))return{loadActiveApprovalCovers:async()=>[]};
 if(id.endsWith('/people-operational-hierarchy'))return{loadPeopleOperationalHierarchy:async()=>({byLocation:new Map(),error:null})};
 if(id.endsWith('salary-hold-policy'))return{holdApprovers:()=>({personIds:[],names:[]})};
 if(id.endsWith('nl-recovery-context'))return{recoveryContext:async(month,key,edit)=>{if(key==='outside'||auth.readOnly&&edit||auth.denied)throw Error('Access denied');return{auth,scope:{company:'C'},station:{id:'S'},caseKey:key};}};
 if(id.startsWith('@/'))return load(path.join(root,'src',id.slice(2)),extra);if(id.startsWith('.'))return load(path.join(path.dirname(file),id),extra);return require(id);
},m,m.exports);return m.exports;}
(async()=>{
 const {assertLifecycleAction}=load('src/lib/ops-pulse/nl-loss-lifecycle.ts');
 const base={companyId:'C',userId:'actor',roleCode:'OPERATIONS_SI',isMasterOwner:false,readOnly:false};
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_BH','OPERATIONS_GM','GENERAL_MANAGER']){
  auth={...base,roleCode};await assert.rejects(()=>assertLifecycleAction(auth,'S','clarify'),/do not have access/);await assertLifecycleAction(auth,'S','propose');await assert.rejects(()=>assertLifecycleAction(auth,'S','approve'),/Only SLP Manager/);
 }
 for(const roleCode of ['OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER','OPERATIONS_MP']){
  auth={...base,roleCode};await assert.rejects(()=>assertLifecycleAction(auth,'S','clarify'),/do not have access/);await assertLifecycleAction(auth,'S','approve','someone-else');await assert.rejects(()=>assertLifecycleAction(auth,'S','approve','actor'),/another authorised/);
 }
 await assert.rejects(()=>assertLifecycleAction({...base,readOnly:true},'S','propose'),/edit access/);
 const api=load('src/app/api/ops-pulse/losses/case-response/route.ts');
 const post=(body,origin='https://ops.dropxlogistics.com')=>api.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/case-response',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({month:'2026-09',case_key:'T1',version:1,note:'Detailed response for review',...body})}));
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_BH','OPERATIONS_GM','GENERAL_MANAGER']){auth={...base,roleCode};for(const action of ['activate','revoke','approve','return','tracking','won','lost'])assert.equal((await post({action})).status,403);}
 assert.equal(rpcCalls,0,'Denied roles cannot invoke a transition');
 auth={...base,roleCode:'OWNER',isMasterOwner:true};assert.equal((await post({action:'activate'})).status,403);
 auth={...base,roleCode:'OPERATIONS_CLM'};const bulkDenied=await post({action:'bulk_activate',rows:[{month:'2026-09',case_key:'T1',version:0}]});assert.equal(bulkDenied.status,403);assert.equal(rpcCalls,0);

 auth={...base,roleCode:'OPERATIONS_SLPM'};assert.equal((await post({action:'tracking',tt_reference:'TT-123',followup_status:'filed',followup_on:'2026-11-01'})).status,200);
 assert.equal((await post({action:'activate'},'https://evil.example')).status,403);
 assert.equal((await post({action:'tracking',tt_url:'javascript:alert(1)'})).status,403);
 assert.equal((await post({action:'tracking',case_key:'outside'})).status,403);
 for(const roleCode of ['OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER']){
  auth={...base,roleCode};
  assert.equal((await post({action:'activate',note:''})).status,200,`${roleCode} can activate without station evidence`);
  const before=rpcCalls;
  const result=await post({action:'bulk_activate',rows:[{month:'2026-09',case_key:'T1',version:0},{month:'2026-09',case_key:'outside',version:0}]});
  assert.equal(result.status,200);
  assert.deepEqual((await result.json()).results.map(r=>r.ok),[true,false]);
  assert.equal(rpcCalls,before+1,'Only an authorised in-scope shipment reaches the database');
 }
 auth={...base,roleCode:'OPERATIONS_SLPM'};
 for(const rows of [[],[null],[{month:'bad',case_key:'T1',version:0}],Array(101).fill({month:'2026-09',case_key:'T1',version:0}),Array(2).fill({month:'2026-09',case_key:'T1',version:0})]){
  const before=rpcCalls;assert.equal((await post({action:'bulk_activate',rows})).status,400);assert.equal(rpcCalls,before,'Invalid bulk input causes no partial writes');
 }
 auth={...base,roleCode:'OPERATIONS_SLPM'};
 const beforeBulk=rpcCalls;
 const mixed=await post({action:'bulk_update',rows:[{month:'2026-09',case_key:'T1',version:1,action:'activate'},{month:'2026-09',case_key:'T2',version:1,action:'revoke',note:'Enabled by mistake, revoke'}]});assert.equal(mixed.status,200);assert.equal(rpcCalls,beforeBulk+2);
 const beforeInvalid=rpcCalls;assert.equal((await post({action:'bulk_update',rows:[{month:'2026-09',case_key:'T1',version:1,action:'activate'},{month:'2026-09',case_key:'T2',version:1,action:'revoke',note:''}]})).status,400);assert.equal(rpcCalls,beforeInvalid);
 auth={...base,roleCode:'OPERATIONS_CLM'};assert.equal((await post({action:'bulk_update',rows:[{month:'2026-09',case_key:'T1',version:1,action:'revoke',note:'Disable this shipment now'}]})).status,403);
 auth={...base,roleCode:'OPERATIONS_SLPM',denied:true};assert.equal((await post({action:'bulk_activate',rows:[{month:'2026-09',case_key:'T1',version:0}]})).status,403);
 auth={...base,roleCode:'OPERATIONS_SLPM',readOnly:true};assert.equal((await post({action:'activate'})).status,403);
 auth={...base,roleCode:'OPERATIONS_SI'};
 const evidence={action:'response',reason:'Wrong loss decision',tt_reference:'CLOAK-123',note:'The package images show the intact return.',evidence_url:'https://drive.google.com/drive/folders/photos',cctv_url:'https://drive.google.com/drive/folders/cctv',cctv_not_required:false};
 for(const field of ['reason','tt_reference','note','evidence_url','cctv_url']){
  const before=rpcCalls;const result=await post({...evidence,[field]:'  '});assert.equal(result.status,403,`${field} must be present`);assert.equal(rpcCalls,before,'Missing evidence never reaches storage');
 }
 for(const value of [false,'true',1,null]){
  const result=await post({...evidence,cctv_url:'',cctv_not_required:value});assert.equal(result.status,403,'Only explicit true waives CCTV');
 }
 for(const field of ['evidence_url','cctv_url'])for(const value of ['http://example.com/a','javascript:alert(1)','https://user:password@example.com/a'])assert.equal((await post({...evidence,[field]:value})).status,403,'Unsafe links rejected');
 assert.equal((await post(evidence)).status,200);assert.equal(lastRpc.p_details.cctv_url,evidence.cctv_url);assert.equal(lastRpc.p_details.cctv_not_required,false);
 assert.equal((await post({...evidence,cctv_not_required:true,cctv_url:''})).status,200);assert.equal(lastRpc.p_details.cctv_not_required,true);assert.equal(lastRpc.p_details.cctv_url,'');
 assert.equal((await post({...evidence,cctv_not_required:true,evidence_url:''})).status,403,'CCTV waiver never waives supporting files');
 assert.equal((await post({...evidence,reason:'x'.repeat(301)})).status,403);
 assert.equal((await post({...evidence,tt_reference:'x'.repeat(161)})).status,403);
 assert.equal((await post({...evidence,note:'x'.repeat(4001)})).status,403);
 assert.equal((await post({...evidence,case_key:'outside'})).status,403);
 auth={...base,roleCode:'OPERATIONS_SI',readOnly:true};assert.equal((await post(evidence)).status,403);
 console.log('PASS actual approval guards and redispute API: station proposals, authorised final roles including Managing Partner; GM denied, no self-approval, read-only, cross-origin, unsafe URL and station-scope denial.');
})().catch(e=>{console.error(e);process.exitCode=1;});
