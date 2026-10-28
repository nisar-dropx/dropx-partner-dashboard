const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),crypto=require('node:crypto');
const moduleUnderTest={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/lib/ops-pulse/loss-payroll-refresh.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id==='server-only'?{}:require(id),moduleUnderTest,moduleUnderTest.exports);
const {refreshLossPayroll}=moduleUnderTest.exports;
(async()=>{
 const old=process.env.SUPABASE_SERVICE_ROLE_KEY, oldFetch=global.fetch;process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
 try {
  global.fetch=async(url,options)=>{assert.equal(url,'https://people.dropxlogistics.com/api/internal/loss-payroll-refresh');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{companyId:'company'});assert.equal(options.headers['x-dropx-signature'],crypto.createHmac('sha256','test-only').update(`dropx:loss-payroll-refresh:v1.${options.headers['x-dropx-time']}.${options.body}`).digest('hex'));return{ok:true,json:async()=>({refreshed:1,unchanged:0,pending:0})}};
  assert.equal((await refreshLossPayroll('company')).status,'synced');
  global.fetch=async()=>({ok:true,json:async()=>({refreshed:0,unchanged:0,pending:0})});assert.equal((await refreshLossPayroll('company')).status,'scheduled');
  global.fetch=async()=>({ok:false});assert.equal((await refreshLossPayroll('company')).status,'pending');
  global.fetch=async()=>{throw Error('timeout')};assert.equal((await refreshLossPayroll('company')).status,'pending','a saved recovery is retained when People cannot be reached');
 }finally{global.fetch=oldFetch;if(old===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=old;}
 console.log('PASS recovery payroll relay: scoped signed request and honest failure status.');
})().catch(e=>{console.error(e);process.exitCode=1});
