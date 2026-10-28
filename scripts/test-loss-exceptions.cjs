const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
let auth,calls=[];
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
 if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:a=>!a.denied};
 if(id.endsWith('/nl-recovery-context'))return{recoveryContext:async(month,key,edit,pending)=>{if(key==='outside'||auth.readOnly||auth.denied||key==='initial'&&!pending)throw Error('Case unavailable');return{auth,scope:{company:'C'},caseKey:key,report:key==='slp-initial'?'slp':'nl',finalSeenAt:null};}};
 if(id.endsWith('/supabase-admin'))return{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return{data:{version:args.p_version+1},error:null};}}};
 if(id.startsWith('@/'))return load('src/'+id.slice(2));if(id.startsWith('.'))return load(path.join(path.dirname(file),id));return require(id);
},m,m.exports);return m.exports;}
(async()=>{
 const {eligibleInstallmentCounts,hasStationSubmission}=load('src/lib/ops-pulse/loss-exceptions.ts');
 const policy={max_installments:24,installment_thresholds_enabled:true,installment_two_month_min:7000,installment_three_month_min:10000,installment_extra_month_step:5000};
 for(const [amount,want]of [[1640,[]],[7000,[]],[7000.01,[2]],[10000,[2]],[10000.01,[2,3]],[15000,[2,3]],[15000.01,[2,3,4]]])assert.deepEqual(eligibleInstallmentCounts([amount],policy),want);
 assert.deepEqual(eligibleInstallmentCounts([18000,7100],policy),[2]);assert.deepEqual(eligibleInstallmentCounts([NaN],policy),[]);assert.deepEqual(eligibleInstallmentCounts([],policy),[]);
 assert.equal(hasStationSubmission({submitted_by:null,response_details:{}}),false);assert.equal(hasStationSubmission({submitted_by:'station',response_details:{reason:'Delivered correctly'}}),true);
 const api=load('src/app/api/ops-pulse/losses/exceptions/route.ts'),base={userId:'actor',roleCode:'OPERATIONS_SLPM',isMasterOwner:false,readOnly:false};
 const row={month:'2026-09',case_key:'T1',kind:'installments',enabled:true,version:0,reason:'Verified final recovery case'};
 const post=(rows=[row],origin='https://ops.dropxlogistics.com')=>api.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/exceptions',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({rows})}));
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','GENERAL_MANAGER','OPERATIONS_GM','OWNER']){auth={...base,roleCode,isMasterOwner:roleCode==='OWNER'};assert.equal((await post()).status,403);}
 assert.equal(calls.length,0);
 for(const roleCode of ['OPERATIONS_SLPM','FINANCE_FINMGR','OPERATIONS_NH','OPERATIONS_MP','MANAGING_PARTNER']){auth={...base,roleCode};assert.equal((await post()).status,200);}
 for(const overrides of [{readOnly:true},{denied:true}]){auth={...base,...overrides};const before=calls.length;assert.equal((await post()).status,403);assert.equal(calls.length,before);}
 auth=base;
 for(const rows of [[],[null],[row,row],[{...row,kind:'__proto__'}],[{...row,reason:''}],Array(101).fill(row)]){const before=calls.length;assert.equal((await post(rows)).status,400);assert.equal(calls.length,before);}
 assert.equal((await post([row],'https://evil.example')).status,403);
 const mixed=await (await post([row,{...row,case_key:'outside'},{...row,case_key:'initial'},{...row,case_key:'slp-initial'}])).json();assert.deepEqual(mixed.results.map(r=>r.ok),[true,false,false,false]);
 await post([{...row,kind:'redispute'}]);assert.equal(calls.at(-1).name,'nl_redispute_transition');assert.equal(calls.at(-1).args.p_action,'activate');
 await post([{...row,kind:'next_month',enabled:false}]);assert.equal(calls.at(-1).name,'nl_loss_exception_set');assert.equal(calls.at(-1).args.p_enabled,false);
 console.log('PASS exception roles, read-only, scope, bulk validation, redispute routing, submission filtering and amount-dependent monthly choices');
})().catch(e=>{console.error(e);process.exitCode=1;});
