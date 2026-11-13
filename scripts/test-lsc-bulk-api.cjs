const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
let auth,calls=[],refreshes=0;
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
 if(id.endsWith('/loss-payroll-refresh'))return{refreshLossPayroll:async()=>{refreshes++;}};
 if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:a=>!a.denied};
 if(id.endsWith('/nl-recovery-context'))return{recoveryContext:async(month,key)=>{if(key==='outside'||auth.readOnly||auth.denied)throw Error('Case unavailable');return{auth,scope:{company:'C'},caseKey:key};}};
 if(id.endsWith('/supabase-admin'))return{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return args.p_case==='stale'?{error:{code:'P0001',message:'This shipment changed. Reload before continuing.'}}:{data:{month:args.p_month,case_key:args.p_case,version:args.p_version+1,workflow_status:'with_vendor',tt_reference:args.p_details.tt_reference},error:null};}}};
 if(id.startsWith('@/'))return load('src/'+id.slice(2));if(id.startsWith('.'))return load(path.join(path.dirname(file),id));return require(id);
},m,m.exports);return m.exports;}
(async()=>{
 const api=load('src/app/api/ops-pulse/losses/case-response/route.ts'),base={userId:'actor',roleCode:'OPERATIONS_SLPM',readOnly:false};
 const row={month:'2026-09',case_key:'T1',version:3};
 const payload={action:'bulk_tracking',tt_reference:'LSC-SHARED',tt_url:'https://example.com/ticket',followup_on:'2026-11-15',note:'Filed all selected shipments',rows:[row,{...row,case_key:'T2'}]};
 const post=(overrides={},origin='https://ops.dropxlogistics.com')=>api.POST(new Request('https://ops.dropxlogistics.com/api/ops-pulse/losses/case-response',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({...payload,...overrides})}));
 for(const roleCode of ['OPERATIONS_SI','OPERATIONS_CLM','OPERATIONS_AOM','OWNER']){auth={...base,roleCode};assert.equal((await post()).status,403);}
 for(const changes of [{readOnly:true},{denied:true}]){auth={...base,...changes};assert.equal((await post()).status,403);}
 assert.equal(calls.length,0);
 for(const roleCode of ['OPERATIONS_SLPM','FINANCE_FINMGR','OPERATIONS_NH','OPERATIONS_MP']){
  auth={...base,roleCode};const response=await post();assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.results.map(r=>r.ok),[true,true]);
  assert.deepEqual(body.results.map(r=>r.window.tt_reference),['LSC-SHARED','LSC-SHARED']);
 }
 auth=base;const before=calls.length;
 for(const changes of [{rows:[]},{rows:[null]},{rows:[row,row]},{rows:Array(101).fill(row)},{tt_reference:''},{tt_reference:'x'.repeat(161)},{tt_url:'http://example.com'},{tt_url:'https://user:pass@example.com'},{followup_on:'2026-02-30'},{followup_on:''},{note:'short'}])assert.equal((await post(changes)).status,400);
 assert.equal((await post({},'https://evil.example')).status,403);assert.equal(calls.length,before);
 const mixed=await(await post({rows:[row,{...row,case_key:'outside'},{...row,case_key:'stale'}]})).json();assert.deepEqual(mixed.results.map(r=>r.ok),[true,false,false]);assert.match(mixed.results[2].error,/changed/);
 await post({rows:[{...row,action:'won',tt_reference:'INJECTED'}]});assert.equal(calls.at(-1).args.p_action,'tracking');assert.equal(calls.at(-1).args.p_details.tt_reference,'LSC-SHARED');
 assert.equal(refreshes,0,'Ticket-only updates must not run financial resettlement');
 const approval=await post({action:'approve',...row,note:'Verified supporting evidence',tt_reference:'',followup_on:''});assert.equal(approval.status,200);assert.equal(calls.at(-1).args.p_action,'approve');
 console.log('PASS: shared tickets, role/access/read-only/origin guards, validation before writes, scoped partial failures, concurrency, forced tracking action and ticket-free approval');
})().catch(e=>{console.error(e);process.exitCode=1;});
