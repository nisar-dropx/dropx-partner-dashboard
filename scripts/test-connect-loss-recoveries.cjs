const ts=require('typescript'),fs=require('fs'),assert=require('node:assert/strict');
const file='apps/connect/app/api/connect/loss-recoveries/route.ts';
let account, rpcArgs, planError=false, paused=false;
const client={rpc:async(name,args)=>{if(name==='nl_recovery_debits')return {data:[{employee_ref:`${account.profileType}:mine`,loss_month:'2026-09',case_key:'slp:TID1',payroll_month:'2026-10',amount:400,is_deducted:true,recovery_key:'own'},{employee_ref:'employee:someone-else',loss_month:'2026-09',case_key:'slp:TID1',amount:900}]};rpcArgs=args; return {data:[
 {employee_ref:`${account.profileType==='workforce'?'workforce':account.profileType==='contractor'?'contractor':'employee'}:${account.id}`,month:'2026-09',case_key:'slp:TID1',report:'slp',station_code:'SPBE',total:400,deducted:400,outstanding:0,in_payroll:0,status:'recovered',last_deducted_in:'2026-10'},
 {employee_ref:'employee:someone-else',month:'2026-09',case_key:'PRIVATE',total:900,outstanding:900},
 {employee_ref:`${account.profileType==='workforce'?'workforce':account.profileType==='contractor'?'contractor':'employee'}:${account.id}`,month:'2026-09',case_key:'DRAFT',total:200,outstanding:200}
 ]};},from:table=>{let key;const q={select:()=>q,eq:(k,v)=>{if(k==='case_key')key=v;return q;},maybeSingle:async()=> table==='nl_loss_month_cases'?{data:{amount:1000,details:{tid:'TID1'}}}:planError?{error:{message:'db failed'}}:{data:{approval_status:key==='DRAFT'?'proposed':paused?'needs_review':'approved',allocations:[{ref:`${account.profileType==='workforce'?'workforce':account.profileType==='contractor'?'contractor':'employee'}:${account.id}`,amount:400}],deduction_month:'2026-10'}}};return q;}};
const mod={exports:{}};
process.env.NEXT_PUBLIC_SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{
 if(id==='next/server')return {NextResponse:{json:(data,init)=>({data,status:init?.status??200})}};
 if(id==='@supabase/supabase-js')return {createClient:()=>client};
 if(id.includes('connect-auth'))return {requireConnectAccount:async(type,id)=>{if(id!==account.id||type!==account.profileType)throw Error('Not your account');return account;}};
 throw Error(id);
},mod,mod.exports);
(async()=>{
for(const profileType of ['employee','workforce','contractor']){
 account={profileType,id:'mine',companyId:'company'};
 const get=(extra='')=>mod.exports.GET(new Request(`https://one.test/api/connect/loss-recoveries?profileType=${profileType}&accountId=mine${extra}`));
 const result=await get(); assert.equal(result.status,200);assert.equal(result.data.recoveries.length,2);
 assert.equal(result.data.recoveries[1].status,'awaiting_approval');assert.equal(result.data.recoveries[1].approvalStatus,'proposed');
 assert.equal(result.data.recoveries[0].status,'recovered');assert.equal(result.data.recoveries[0].caseAmount,1000);assert.equal(result.data.recoveries[0].myShareAmount,400);assert.equal(result.data.recoveries[0].deducted,400);
 assert.equal(result.data.recoveries[0].deductions.length,1);assert.equal(result.data.recoveries[0].deductions[0].amount,400);
 assert.equal(rpcArgs.p_ref,`${profileType}:mine`);
 assert.equal((await get('&month=2026-09&caseKey=PRIVATE')).data.recoveries.length,0);
 assert.equal((await get('&month=2026-08&caseKey=slp:TID1')).data.recoveries.length,0);
 assert.equal((await mod.exports.GET(new Request(`https://one.test/api/connect/loss-recoveries?profileType=${profileType}&accountId=other`))).status,400);
 paused=true;assert.equal((await get()).data.recoveries[0].deducted,400);paused=false;
 planError=true;assert.equal((await get()).status,400);planError=false;
}
console.log('PASS own-account completed recovery history, case value/share, own proposal status, specific-case lookup and DB errors for People and Workforce');
})().catch(e=>{console.error(e);process.exitCode=1});
