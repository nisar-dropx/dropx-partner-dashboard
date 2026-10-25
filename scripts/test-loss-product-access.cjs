const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.cwd();let auth,windowEnabled=false,rpcCalls=0;
const db={from(){const q=new Proxy({}, {get(_,k){if(k==='then')return resolve=>resolve({data:[],error:null});return ()=>q;}});return q;},rpc:async()=>{rpcCalls++;return {data:{version:2},error:null};}};
function load(file,extra={}){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(id=>{
 if(id in extra)return extra[id];if(id==='server-only')return{};
 if(id.endsWith('/authorization'))return{hasPermission:(a,p,act)=>!a.denied};
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
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_BH']){
  auth={...base,roleCode};await assertLifecycleAction(auth,'S','propose');await assert.rejects(()=>assertLifecycleAction(auth,'S','approve'),/Only SLP Manager/);
 }
 for(const roleCode of ['OPERATIONS_SLPM','OPERATIONS_NH','OPERATIONS_FINMGR','OPERATIONS_MANAGING_PARTNER']){
  auth={...base,roleCode};await assertLifecycleAction(auth,'S','approve','someone-else');await assert.rejects(()=>assertLifecycleAction(auth,'S','approve','actor'),/another authorised/);
 }
 await assert.rejects(()=>assertLifecycleAction({...base,readOnly:true},'S','propose'),/edit access/);
 const api=load('src/app/api/ops-pulse/losses/case-response/route.ts');
 const post=(body,origin='https://ops.dropxlogistics.com')=>api.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/case-response',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({month:'2026-09',case_key:'T1',version:1,note:'Detailed response for review',...body})}));
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','OPERATIONS_BH']){auth={...base,roleCode};for(const action of ['activate','revoke','vendor_response','tracking'])assert.equal((await post({action})).status,403);}
 assert.equal(rpcCalls,0,'Denied roles cannot invoke a transition');
 auth={...base,roleCode:'OPERATIONS_SLPM'};assert.equal((await post({action:'tracking',tt_reference:'TT-123',followup_status:'filed',followup_on:'2026-11-01'})).status,200);
 assert.equal((await post({action:'activate'},'https://evil.example')).status,403);
 assert.equal((await post({action:'tracking',tt_url:'javascript:alert(1)'})).status,403);
 assert.equal((await post({action:'tracking',case_key:'outside'})).status,403);
 auth={...base,roleCode:'OPERATIONS_SLPM',readOnly:true};assert.equal((await post({action:'activate'})).status,403);
 console.log('PASS actual approval guards and redispute API: station proposals, exactly four final roles, no self-approval, read-only, cross-origin, unsafe URL and station-scope denial.');
})().catch(e=>{console.error(e);process.exitCode=1;});
