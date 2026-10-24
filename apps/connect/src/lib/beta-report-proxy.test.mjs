import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function load(path,mocks={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>mocks[n],m,m.exports);return m.exports;}
const pdf=load('./beta-report.ts'),{fetchBetaReportFile:run,BetaReportError}=load('./beta-report-proxy.ts',{'./beta-report':pdf});
process.env.WORKFORCE_AMAZON_WORKER_URL='https://worker.example.test';process.env.WORKFORCE_AMAZON_WORKER_KEY='test-only';
const candidate='candidate',headers={'Content-Type':'application/pdf','X-Report-Candidate':candidate,'X-Report-Profile':'123','X-Report-Prepared-At':'2026-10-24T10:00:00Z'};
test('PDF bytes, timestamp and safe filename reach the portal without a signed provider URL',async()=>{global.fetch=async(url,init)=>{assert.equal(new URL(url).pathname,'/api/admin/beta/idfy/report/file');assert.equal(JSON.parse(init.body).candidateId,candidate);return new Response('%PDF-1.7 test',{headers});};const r=await run(candidate);assert.equal(r.headers['Cache-Control'],'private, no-store');assert.equal(r.headers['X-Report-Prepared-At'],headers['X-Report-Prepared-At']);assert.equal(r.profile,'123');assert.equal(new TextDecoder().decode(r.pdf),'%PDF-1.7 test');});
test('foreign candidate and malformed profile files fail closed',async()=>{for(const change of [{'X-Report-Candidate':'other'},{'X-Report-Profile':'../../x'}]){global.fetch=async()=>new Response('%PDF-1.7',{headers:{...headers,...change}});await assert.rejects(run(candidate),e=>e instanceof BetaReportError&&e.code==='identity_unavailable');}});
test('a HTML error labelled PDF cannot become a downloadable report',async()=>{global.fetch=async()=>new Response('<html>error</html>',{headers});await assert.rejects(run(candidate),e=>e.code==='pdf_unavailable');});
test('provider error text is not exposed; safe code and reference remain available',async()=>{global.fetch=async()=>Response.json({error:'SECRET TOKEN / private URL',code:'provider_slow',requestId:'4732e7e3-df91-4c8b-8ea4-0ed77f382313'},{status:503});await assert.rejects(run(candidate),e=>e.code==='provider_slow'&&!e.message.includes('SECRET')&&Boolean(e.requestId));});
